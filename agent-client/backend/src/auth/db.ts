import fs from 'node:fs';
import path from 'node:path';

/**
 * `node:sqlite` 的最小同步适配层。
 *
 * 之所以不用 better-sqlite3：在目标服务器（Ubuntu 22.04 / Node 22.12）上，
 * 它的预编译与源码重编版本都在新建连接时段错误；内置 `node:sqlite` 实测可用。
 * 该模块只在鉴权开关打开时被动态 import，开发实例不会触碰它。
 */
export interface SqlStatement {
  run(...params: Array<string | number | null>): { changes: number; lastInsertRowid: number };
  get(...params: Array<string | number | null>): unknown;
  all(...params: Array<string | number | null>): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  created_ip TEXT,
  last_login_at TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_codes_lookup ON verification_codes(email, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_codes_ip ON verification_codes(ip, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  user_id TEXT,
  email TEXT,
  ip TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

CREATE TABLE IF NOT EXISTS user_llm_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  thinking_format TEXT NOT NULL DEFAULT 'none',
  protocol TEXT,
  default_model_id TEXT,
  models_json TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  preset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_llm_user ON user_llm_providers(user_id);

CREATE TABLE IF NOT EXISTS user_role_bindings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  thinking_level TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
`;

/**
 * Additive column migration without a version table.
 *
 * The file ships at schema v1 and `protocol` arrived later. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so a live deployment would otherwise keep a database
 * without the column. The check is idempotent and the column is nullable, which keeps every
 * pre-existing row on the historical OpenAI-compatible default.
 */
function addColumnIfMissing(database: { prepare(sql: string): { all(...params: Array<string | number | null>): unknown[] }; exec(sql: string): void }, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export async function openAuthDatabase(dbPath: string): Promise<SqlDatabase> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error(
      'Auth storage requires Node.js with --experimental-sqlite (Node 22.12). '
      + 'Start the backend through `npm start`, `bin/bioflow.mjs`, or `node --experimental-sqlite dist/index.js`.',
    );
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec(SCHEMA);
  addColumnIfMissing(database, 'user_llm_providers', 'protocol', 'TEXT');

  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        run: (...params) => {
          const result = statement.run(...params);
          return {
            changes: Number(result.changes),
            lastInsertRowid: Number(result.lastInsertRowid),
          };
        },
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
      };
    },
    close: () => database.close(),
  };
}
