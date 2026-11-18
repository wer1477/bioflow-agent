import path from 'node:path';
import { BACKEND_ROOT } from '../paths.js';

/**
 * 登录鉴权配置。
 *
 * 默认关闭：开发实例不设置 `BIOFLOW_AUTH_ENABLED` 时，鉴权中间件、会话表与
 * 邮件通道都不会加载，API 行为与未引入登录前完全一致。部署实例在 `.env.prod`
 * 里显式打开，并按需提供 SMTP 与管理员邮箱。
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  fromName: string;
}

export interface AuthConfig {
  enabled: boolean;
  dbPath: string;
  adminEmails: Set<string>;
  cookieName: string;
  cookieSecure: boolean;
  sessionDays: number;
  rememberDays: number;
  codeTtlSeconds: number;
  codeResendSeconds: number;
  codesPerHourPerEmail: number;
  codesPerHourPerIp: number;
  registrationsPerDayPerIp: number;
  loginMaxFailures: number;
  loginLockMinutes: number;
  auditRetentionDays: number;
  smtp: SmtpConfig | null;
}

const ENABLED_PATTERN = /^(1|true|yes|on)$/i;

export function isAuthEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_PATTERN.test(String(environment.BIOFLOW_AUTH_ENABLED || '').trim());
}

export function parseAdminEmails(value: string | undefined): Set<string> {
  return new Set(
    String(value || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function readAuthConfig(environment: NodeJS.ProcessEnv = process.env): AuthConfig {
  const smtp = readSmtpConfig(environment);
  return {
    enabled: isAuthEnabled(environment),
    dbPath: path.resolve(
      String(environment.BIOFLOW_AUTH_DB || '').trim() || path.join(BACKEND_ROOT, 'data', 'auth.sqlite'),
    ),
    adminEmails: parseAdminEmails(environment.BIOFLOW_AUTH_ADMIN_EMAILS),
    cookieName: String(environment.BIOFLOW_AUTH_COOKIE_NAME || '').trim() || 'bioflow_session',
    // 生产必须走 HTTPS；本地 http 调试时显式设 0。
    cookieSecure: readBoolean(environment.BIOFLOW_AUTH_COOKIE_SECURE, true),
    sessionDays: readPositiveInt(environment.BIOFLOW_AUTH_SESSION_DAYS, 7),
    rememberDays: readPositiveInt(environment.BIOFLOW_AUTH_REMEMBER_DAYS, 30),
    codeTtlSeconds: readPositiveInt(environment.BIOFLOW_AUTH_CODE_TTL_SECONDS, 600),
    codeResendSeconds: readPositiveInt(environment.BIOFLOW_AUTH_CODE_RESEND_SECONDS, 60),
    codesPerHourPerEmail: readPositiveInt(environment.BIOFLOW_AUTH_CODES_PER_HOUR_EMAIL, 5),
    codesPerHourPerIp: readPositiveInt(environment.BIOFLOW_AUTH_CODES_PER_HOUR_IP, 20),
    registrationsPerDayPerIp: readPositiveInt(environment.BIOFLOW_AUTH_REGISTRATIONS_PER_DAY_IP, 5),
    loginMaxFailures: readPositiveInt(environment.BIOFLOW_AUTH_LOGIN_MAX_FAILURES, 5),
    loginLockMinutes: readPositiveInt(environment.BIOFLOW_AUTH_LOGIN_LOCK_MINUTES, 15),
    auditRetentionDays: readPositiveInt(environment.BIOFLOW_AUTH_AUDIT_DAYS, 30),
    smtp,
  };
}

export function readSmtpConfig(environment: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = String(environment.BIOFLOW_AUTH_SMTP_HOST || '').trim();
  const user = String(environment.BIOFLOW_AUTH_SMTP_USER || '').trim();
  const pass = String(environment.BIOFLOW_AUTH_SMTP_PASS || '');
  if (!host || !user || !pass) return null;

  const port = readPositiveInt(environment.BIOFLOW_AUTH_SMTP_PORT, 465);
  const from = String(environment.BIOFLOW_AUTH_MAIL_FROM || '').trim() || user;
  const fromName = String(environment.BIOFLOW_AUTH_MAIL_FROM_NAME || '').trim() || 'Bioflow';
  return {
    host,
    port,
    // 465 是隐式 TLS，587 走 STARTTLS（Nodemailer 的 secure=false）。
    secure: readBoolean(environment.BIOFLOW_AUTH_SMTP_SECURE, port === 465),
    user,
    pass,
    from,
    fromName,
  };
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
