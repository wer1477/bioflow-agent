import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT } from '../paths.js';

/**
 * 用户意见反馈的本地 SQLite 存储。
 *
 * 反馈是跨用户收敛的运营数据，因此固定写入进程级 WORKSPACE_ROOT，而不是
 * 鉴权部署下的 per-user workspace。数据库按需打开：开发实例即使没有反馈，
 * 也不会在启动时触碰 SQLite。
 */
export interface FeedbackInput {
  content: string;
  category: string;
  contact?: string;
  page?: string;
  userId?: string | null;
  email?: string | null;
  userAgent?: string | null;
}

export interface FeedbackRecord {
  id: number;
  createdAt: string;
  category: string;
  content: string;
  contact: string;
  page: string;
  userId: string | null;
  email: string | null;
  userAgent: string | null;
  appVersion: string;
  status: string;
}

interface FeedbackDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: Array<string | number | null>): { changes: number; lastInsertRowid: number };
    get(...params: Array<string | number | null>): unknown;
    all(...params: Array<string | number | null>): unknown[];
  };
  close(): void;
}

/** 应用版本随每条反馈落库，便于区分反馈来自哪次构建。 */
export const APP_VERSION = readPackageVersion();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  user_id TEXT,
  email TEXT,
  contact TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  content TEXT NOT NULL,
  page TEXT NOT NULL DEFAULT '',
  user_agent TEXT,
  app_version TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at);
`;

let database: FeedbackDatabase | null = null;
let databasePath = '';

export function feedbackDatabasePath(): string {
  const configured = String(process.env.BIOFLOW_FEEDBACK_DB || '').trim();
  return configured ? path.resolve(configured) : path.join(WORKSPACE_ROOT, 'feedback.sqlite');
}

export async function saveFeedback(input: FeedbackInput): Promise<{ id: number; createdAt: string; appVersion: string }> {
  const db = await openDatabase();
  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO feedback (created_at, user_id, email, contact, category, content, page, user_agent, app_version, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(
    createdAt,
    input.userId || null,
    input.email || null,
    input.contact || '',
    input.category,
    input.content,
    input.page || '',
    input.userAgent || null,
    APP_VERSION,
  );
  return { id: result.lastInsertRowid, createdAt, appVersion: APP_VERSION };
}

/** Recent first; shared by the admin inbox and tests. */
export async function listFeedback(limit = 100, offset = 0): Promise<FeedbackRecord[]> {
  const db = await openDatabase();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const rows = db.prepare(`
    SELECT id, created_at, category, content, contact, page, user_id, email, user_agent, app_version, status
    FROM feedback ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(safeLimit, safeOffset);
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: Number(record.id),
      createdAt: String(record.created_at || ''),
      category: String(record.category || 'other'),
      content: String(record.content || ''),
      contact: String(record.contact || ''),
      page: String(record.page || ''),
      userId: record.user_id == null ? null : String(record.user_id),
      email: record.email == null ? null : String(record.email),
      userAgent: record.user_agent == null ? null : String(record.user_agent),
      appVersion: String(record.app_version || ''),
      status: String(record.status || 'open'),
    };
  });
}

/** 管理员收件箱的分页总数。 */
export async function countFeedback(): Promise<number> {
  const db = await openDatabase();
  const row = db.prepare('SELECT COUNT(*) AS total FROM feedback').get() as Record<string, unknown> | undefined;
  return Number(row?.total || 0);
}

/** Test hook: closes the singleton so a new BIOFLOW_FEEDBACK_DB can take effect. */
export function closeFeedbackDatabase(): void {
  if (!database) return;
  try {
    database.close();
  } finally {
    database = null;
    databasePath = '';
  }
}

async function openDatabase(): Promise<FeedbackDatabase> {
  const target = feedbackDatabasePath();
  if (database && databasePath === target) return database;
  if (database) closeFeedbackDatabase();

  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error('反馈存储需要 Node.js 的 SQLite 支持（Node 22 请使用 --experimental-sqlite 启动）。');
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const db = new sqlite.DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  database = db as unknown as FeedbackDatabase;
  databasePath = target;
  return database;
}

function readPackageVersion(): string {
  try {
    const payload = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(payload) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
