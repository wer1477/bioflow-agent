import crypto from 'node:crypto';
import type { AuthConfig } from './config.js';
import type { SqlDatabase } from './db.js';
import { AuthError } from './errors.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Mailer } from './mailer.js';
import {
  hashToken,
  hashVerificationCode,
  randomNumericCode,
  randomToken,
  verifyVerificationCode,
} from './crypto.js';
import type { AuthUser, CodePurpose, SessionLookup } from './types.js';

interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  created_at: string;
  created_ip: string | null;
  last_login_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  remember: number;
  ip: string | null;
  user_agent: string | null;
  revoked_at: string | null;
}

interface CodeRow {
  id: string;
  email: string;
  purpose: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  created_at: string;
  consumed_at: string | null;
}

export interface AuthServiceOptions {
  config: AuthConfig;
  db: SqlDatabase;
  mailer: Mailer;
  now?: () => Date;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: string;
  maxAgeSeconds: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
}

export interface LoginInput {
  email: string;
  password: string;
  remember: boolean;
  ip: string | null;
  userAgent: string | null;
}

/** 管理员操作者身份，用于审计（不含密码/令牌）。 */
export interface AdminActor {
  id: string;
  email: string;
  ip: string | null;
}

export interface AdminUserRow {
  id: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
  providerCount: number;
}

export interface AuditEntry {
  id: number;
  at: string;
  event: string;
  userId: string | null;
  email: string | null;
  ip: string | null;
  detail: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOUCH_INTERVAL_MS = 60_000;

export function normalizeEmail(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function assertValidEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new AuthError(400, '邮箱格式不正确。');
  }
}

export function assertValidPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(400, `密码至少 ${MIN_PASSWORD_LENGTH} 位。`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(400, '密码过长。');
  }
}

export class AuthService {
  private readonly config: AuthConfig;
  private readonly db: SqlDatabase;
  private readonly mailer: Mailer;
  private readonly now: () => Date;

  constructor(options: AuthServiceOptions) {
    this.config = options.config;
    this.db = options.db;
    this.mailer = options.mailer;
    this.now = options.now ?? (() => new Date());
  }

  /** 用户 LLM provider / 角色绑定等 auth 域数据共用同一个 SQLite 连接。 */
  get database(): SqlDatabase {
    return this.db;
  }

  async requestCode(input: { email: string; purpose: CodePurpose; ip: string | null }): Promise<void> {
    const email = normalizeEmail(input.email);
    assertValidEmail(email);
    const user = this.findUserRow(email);
    if (input.purpose === 'register' && user) {
      throw new AuthError(409, '该邮箱已注册，请直接登录或找回密码。');
    }
    this.assertCodeRateLimits(email, input.purpose, input.ip);

    const code = randomNumericCode(6);
    const createdAt = this.nowIso();
    const expiresAt = new Date(this.now().getTime() + this.config.codeTtlSeconds * 1000).toISOString();
    const codeHash = hashVerificationCode(email, input.purpose, code);
    this.transaction(() => {
      // 同一邮箱同用途只保留最新一条有效验证码。
      this.db
        .prepare('UPDATE verification_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL')
        .run(createdAt, email, input.purpose);
      this.db
        .prepare(`
          INSERT INTO verification_codes (id, email, purpose, code_hash, attempts, ip, created_at, expires_at, consumed_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)
        `)
        .run(crypto.randomUUID(), email, input.purpose, codeHash, input.ip, createdAt, expiresAt);
    });
    this.recordAudit('code_sent', { email, ip: input.ip, detail: input.purpose });

    // 找回密码对未注册邮箱不发信，但响应保持一致，避免枚举。
    if (input.purpose === 'reset' && !user) return;
    await this.mailer.sendVerificationCode({
      to: email,
      code,
      purpose: input.purpose,
      ttlMinutes: Math.max(1, Math.round(this.config.codeTtlSeconds / 60)),
    });
  }

  async register(input: RegisterInput): Promise<{ user: AuthUser; session: CreatedSession }> {
    const email = normalizeEmail(input.email);
    assertValidEmail(email);
    assertValidPassword(input.password);
    if (this.findUserRow(email)) {
      throw new AuthError(409, '该邮箱已注册，请直接登录或找回密码。');
    }
    this.consumeCode(email, 'register', String(input.code || ''));
    this.assertRegistrationRateLimit(input.ip);

    const passwordHash = await hashPassword(input.password);
    const id = crypto.randomUUID();
    const createdAt = this.nowIso();
    const role = this.config.adminEmails.has(email) ? 'admin' : 'user';
    try {
      this.db
        .prepare(`
          INSERT INTO users
            (id, email, email_normalized, password_hash, role, status, created_at, created_ip, last_login_at, failed_login_count, locked_until)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, NULL)
        `)
        .run(id, email, email, passwordHash, role, createdAt, input.ip, createdAt);
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        throw new AuthError(409, '该邮箱已注册，请直接登录或找回密码。');
      }
      throw error;
    }
    this.recordAudit('register', { userId: id, email, ip: input.ip });

    const user = this.requireUser(id);
    const session = this.createSession(user, false, input.ip, input.userAgent);
    return { user, session };
  }

  async login(input: LoginInput): Promise<{ user: AuthUser; session: CreatedSession }> {
    const email = normalizeEmail(input.email);
    assertValidEmail(email);
    const row = this.findUserRow(email);
    const generic = new AuthError(401, '邮箱或密码错误。');
    if (!row) {
      this.recordAudit('login_failed', { email, ip: input.ip });
      throw generic;
    }
    if (row.status === 'disabled') {
      throw new AuthError(403, '该账号已被禁用。');
    }
    if (row.locked_until && Date.parse(row.locked_until) > this.now().getTime()) {
      throw new AuthError(429, `尝试次数过多，请 ${this.config.loginLockMinutes} 分钟后再试。`);
    }

    const ok = await verifyPassword(row.password_hash, input.password);
    if (!ok) {
      const failures = Number(row.failed_login_count) + 1;
      const lockedUntil = failures >= this.config.loginMaxFailures
        ? new Date(this.now().getTime() + this.config.loginLockMinutes * 60_000).toISOString()
        : null;
      this.db
        .prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?')
        .run(failures, lockedUntil, row.id);
      this.recordAudit('login_failed', { userId: row.id, email, ip: input.ip });
      throw generic;
    }

    let role = row.role;
    if (this.config.adminEmails.has(email) && role !== 'admin') {
      role = 'admin';
      this.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(row.id);
      this.recordAudit('admin_granted', { userId: row.id, email, ip: input.ip });
    }
    const loginAt = this.nowIso();
    this.db
      .prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(loginAt, row.id);
    this.recordAudit('login', { userId: row.id, email, ip: input.ip });

    const user = this.toAuthUser({ ...row, role, failed_login_count: 0, locked_until: null, last_login_at: loginAt });
    const session = this.createSession(user, input.remember, input.ip, input.userAgent);
    return { user, session };
  }

  getSession(token: string): SessionLookup | null {
    if (!token) return null;
    const sessionId = hashToken(token);
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL')
      .get(sessionId) as SessionRow | undefined;
    if (!row) return null;

    const now = this.now();
    if (Date.parse(row.expires_at) <= now.getTime()) {
      this.revokeSession(row.id);
      return null;
    }
    const userRow = this.findUserRowById(row.user_id);
    if (!userRow || userRow.status !== 'active') {
      this.revokeSession(row.id);
      return null;
    }

    const days = row.remember ? this.config.rememberDays : this.config.sessionDays;
    let expiresAt = row.expires_at;
    let extended = false;
    if (now.getTime() - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
      expiresAt = new Date(now.getTime() + days * DAY_MS).toISOString();
      this.db
        .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        .run(now.toISOString(), expiresAt, row.id);
      extended = true;
    }
    return {
      sessionId: row.id,
      user: this.toAuthUser(userRow),
      expiresAt,
      maxAgeSeconds: days * 86_400,
      extended,
    };
  }

  logout(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.revokeSession(sessionId);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionId?: string): Promise<void> {
    assertValidPassword(newPassword);
    const row = this.findUserRowById(userId);
    if (!row) throw new AuthError(401, '未登录或登录已过期。');
    const ok = await verifyPassword(row.password_hash, currentPassword);
    if (!ok) throw new AuthError(400, '当前密码不正确。');
    const passwordHash = await hashPassword(newPassword);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    this.revokeAllSessions(userId, keepSessionId);
    this.recordAudit('password_change', { userId, email: row.email });
  }

  async resetPassword(input: { email: string; code: string; password: string }): Promise<void> {
    const email = normalizeEmail(input.email);
    assertValidEmail(email);
    assertValidPassword(input.password);
    const row = this.findUserRow(email);
    if (!row) {
      // 与验证码错误同一响应，避免泄露邮箱是否注册。
      throw new AuthError(400, '验证码不正确或已过期。');
    }
    this.consumeCode(email, 'reset', String(input.code || ''));
    const passwordHash = await hashPassword(input.password);
    this.db.prepare('UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?')
      .run(passwordHash, row.id);
    this.revokeAllSessions(row.id);
    this.recordAudit('password_reset', { userId: row.id, email, ip: null });
  }

  revokeAllSessions(userId: string, exceptSessionId?: string): void {
    const revokedAt = this.nowIso();
    if (exceptSessionId) {
      this.db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
        .run(revokedAt, userId, exceptSessionId);
      return;
    }
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(revokedAt, userId);
  }

  findUserByEmail(email: string): AuthUser | null {
    const row = this.findUserRow(normalizeEmail(email));
    return row ? this.toAuthUser(row) : null;
  }

  /** 管理员用户列表：最小字段（状态、最近登录、活跃会话、自建 provider 数）。 */
  listUsers(options: { query?: string; limit?: number; offset?: number } = {}): { users: AdminUserRow[]; total: number } {
    const needle = normalizeEmail(options.query || '');
    const limit = Math.min(Math.max(Math.trunc(Number(options.limit) || 50), 1), 200);
    const offset = Math.max(Math.trunc(Number(options.offset) || 0), 0);
    const pattern = `%${needle}%`;
    const totalRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM users WHERE email_normalized LIKE ?')
      .get(pattern) as { count: number } | undefined;
    const rows = this.db.prepare(`
      SELECT u.id, u.email, u.role, u.status, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM sessions s
          WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions,
        (SELECT COUNT(*) FROM user_llm_providers p WHERE p.user_id = u.id) AS provider_count
      FROM users u
      WHERE u.email_normalized LIKE ?
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ? OFFSET ?
    `).all(this.nowIso(), pattern, limit, offset) as Array<UserRow & { active_sessions: number; provider_count: number }>;
    return {
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        activeSessions: Number(row.active_sessions),
        providerCount: Number(row.provider_count),
      })),
      total: Number(totalRow?.count ?? 0),
    };
  }

  setUserStatus(userId: string, status: 'active' | 'disabled', actor: AdminActor): AuthUser {
    const row = this.findUserRowById(userId);
    if (!row) throw new AuthError(404, '用户不存在。');
    if (row.id === actor.id) throw new AuthError(400, '不能修改当前登录账号的状态。');
    this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
    if (status === 'disabled') this.revokeAllSessions(userId);
    this.recordAudit(status === 'disabled' ? 'admin_disable' : 'admin_enable', {
      userId,
      email: row.email,
      ip: actor.ip,
      detail: `by ${actor.email}`,
    });
    return this.toAuthUser({ ...row, status });
  }

  revokeUserSessions(userId: string, actor: AdminActor): number {
    const row = this.findUserRowById(userId);
    if (!row) throw new AuthError(404, '用户不存在。');
    const before = this.db
      .prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL')
      .get(userId) as { count: number } | undefined;
    this.revokeAllSessions(userId);
    this.recordAudit('admin_revoke_sessions', { userId, email: row.email, ip: actor.ip, detail: `by ${actor.email}` });
    return Number(before?.count ?? 0);
  }

  /** 管理员触发重置邮件：复用用户自助找回的验证码流程，用户仍用验证码改密。 */
  async adminSendPasswordReset(userId: string, actor: AdminActor): Promise<void> {
    const row = this.findUserRowById(userId);
    if (!row) throw new AuthError(404, '用户不存在。');
    if (row.status !== 'active') throw new AuthError(400, '该账号已被禁用，无法发送重置邮件。');
    await this.requestCode({ email: row.email, purpose: 'reset', ip: actor.ip });
    this.recordAudit('admin_password_reset_sent', { userId, email: row.email, ip: actor.ip, detail: `by ${actor.email}` });
  }

  listAudit(options: { limit?: number; before?: string; event?: string; userId?: string } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(Math.trunc(Number(options.limit) || 100), 1), 200);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.before) { clauses.push('at < ?'); params.push(options.before); }
    if (options.event) { clauses.push('event = ?'); params.push(options.event); }
    if (options.userId) { clauses.push('user_id = ?'); params.push(options.userId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT id, at, event, user_id, email, ip, detail FROM audit_log
      ${where}
      ORDER BY at DESC, id DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: number; at: string; event: string; user_id: string | null; email: string | null; ip: string | null; detail: string | null;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      at: row.at,
      event: row.event,
      userId: row.user_id,
      email: row.email,
      ip: row.ip,
      detail: row.detail,
    }));
  }

  cleanup(): void {
    const now = this.now();
    const sessionCutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const codeCutoff = new Date(now.getTime() - 1 * DAY_MS).toISOString();
    const auditCutoff = new Date(now.getTime() - this.config.auditRetentionDays * DAY_MS).toISOString();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
      .run(now.toISOString(), sessionCutoff);
    this.db.prepare('DELETE FROM verification_codes WHERE expires_at < ?').run(codeCutoff);
    this.db.prepare('DELETE FROM audit_log WHERE at < ?').run(auditCutoff);
  }

  private createSession(
    user: AuthUser,
    remember: boolean,
    ip: string | null,
    userAgent: string | null,
  ): CreatedSession {
    const token = randomToken(32);
    const sessionId = hashToken(token);
    const now = this.now();
    const days = remember ? this.config.rememberDays : this.config.sessionDays;
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + days * DAY_MS).toISOString();
    this.db
      .prepare(`
        INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, remember, ip, user_agent, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(sessionId, user.id, nowIso, nowIso, expiresAt, remember ? 1 : 0, ip, userAgent);
    return { token, sessionId, expiresAt, maxAgeSeconds: days * 86_400 };
  }

  private revokeSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.nowIso(), sessionId);
  }

  private consumeCode(email: string, purpose: CodePurpose, code: string): void {
    const row = this.db
      .prepare(`
        SELECT * FROM verification_codes
        WHERE email = ? AND purpose = ? AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(email, purpose) as CodeRow | undefined;
    if (!row) throw new AuthError(400, '验证码不正确或已过期。');
    const invalid = new AuthError(400, '验证码不正确或已过期。');
    if (Date.parse(row.expires_at) <= this.now().getTime()) {
      this.db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(this.nowIso(), row.id);
      throw invalid;
    }
    if (Number(row.attempts) >= 5) {
      this.db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(this.nowIso(), row.id);
      throw invalid;
    }
    if (!verifyVerificationCode(row.code_hash, email, purpose, code)) {
      const attempts = Number(row.attempts) + 1;
      const consumedAt = attempts >= 5 ? this.nowIso() : null;
      this.db.prepare('UPDATE verification_codes SET attempts = ?, consumed_at = ? WHERE id = ?')
        .run(attempts, consumedAt, row.id);
      throw invalid;
    }
    this.db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(this.nowIso(), row.id);
  }

  private assertCodeRateLimits(email: string, purpose: CodePurpose, ip: string | null): void {
    const now = this.now().getTime();
    const recent = this.db
      .prepare(`
        SELECT created_at FROM verification_codes
        WHERE email = ? AND purpose = ?
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(email, purpose) as { created_at: string } | undefined;
    if (recent && now - Date.parse(recent.created_at) < this.config.codeResendSeconds * 1000) {
      throw new AuthError(429, '请稍后再获取验证码。');
    }
    const hourAgo = new Date(now - HOUR_MS).toISOString();
    const emailCount = this.count(
      'SELECT COUNT(*) AS count FROM verification_codes WHERE email = ? AND purpose = ? AND created_at > ?',
      email, purpose, hourAgo,
    );
    if (emailCount >= this.config.codesPerHourPerEmail) {
      throw new AuthError(429, '验证码请求过于频繁，请稍后再试。');
    }
    if (ip) {
      const ipCount = this.count(
        'SELECT COUNT(*) AS count FROM verification_codes WHERE ip = ? AND created_at > ?',
        ip, hourAgo,
      );
      if (ipCount >= this.config.codesPerHourPerIp) {
        throw new AuthError(429, '验证码请求过于频繁，请稍后再试。');
      }
    }
  }

  private assertRegistrationRateLimit(ip: string | null): void {
    if (!ip) return;
    const dayAgo = new Date(this.now().getTime() - DAY_MS).toISOString();
    const count = this.count(
      'SELECT COUNT(*) AS count FROM users WHERE created_ip = ? AND created_at > ?',
      ip, dayAgo,
    );
    if (count >= this.config.registrationsPerDayPerIp) {
      throw new AuthError(429, '注册过于频繁，请稍后再试。');
    }
  }

  private count(sql: string, ...params: Array<string | number | null>): number {
    const row = this.db.prepare(sql).get(...params) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private findUserRow(email: string): UserRow | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE email_normalized = ?')
      .get(email) as UserRow | undefined;
  }

  private findUserRowById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  private requireUser(id: string): AuthUser {
    const row = this.findUserRowById(id);
    if (!row) throw new AuthError(500, '用户记录缺失。');
    return this.toAuthUser(row);
  }

  private toAuthUser(row: UserRow): AuthUser {
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };
  }

  private recordAudit(
    event: string,
    fields: { userId?: string | null; email?: string | null; ip?: string | null; detail?: string | null },
  ): void {
    try {
      this.db
        .prepare('INSERT INTO audit_log (at, event, user_id, email, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
        .run(this.nowIso(), event, fields.userId ?? null, fields.email ?? null, fields.ip ?? null, fields.detail ?? null);
    } catch (error) {
      // 审计失败不应影响主流程。
      console.warn(`[auth] audit write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 忽略回滚失败，抛出原始错误。
      }
      throw error;
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
