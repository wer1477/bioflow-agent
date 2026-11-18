import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import { readAuthConfig, type AuthConfig } from './config.js';
import { openAuthDatabase, type SqlDatabase } from './db.js';
import { createAuthRouter } from './router.js';
import { createAuthMiddleware } from './middleware.js';
import { AuthService } from './service.js';
import { createNullMailer, createSmtpMailer, type Mailer } from './mailer.js';
import { loadSecretBoxKey } from './secret_box.js';

export interface AuthModule {
  enabled: boolean;
  /** 挂载点：`/api/auth`。关闭时只提供 `/mode`。 */
  router: Router;
  /** 关闭时为 null；打开时挂在根路径，只拦截 `/api/*`。 */
  middleware: RequestHandler | null;
  service: AuthService | null;
  /** 鉴权 SQLite 连接；用户 LLM provider / 角色绑定也复用它。 */
  database: SqlDatabase | null;
  /** 用户 LLM API key 的 AES-256-GCM 主密钥。 */
  secretKey: Buffer | null;
  config: AuthConfig;
  close(): void;
}

export interface CreateAuthModuleOptions {
  config?: AuthConfig;
  db?: SqlDatabase;
  mailer?: Mailer;
  now?: () => Date;
  /** 覆盖 `auth-secret.key` 路径（测试用）。 */
  secretKeyPath?: string;
}

/**
 * 装配鉴权模块。
 *
 * 重要：`node:sqlite` 只在 enabled 时通过 `openAuthDatabase()` 动态加载，
 * 因此开发实例（开关关闭）既不碰数据库，也不需要 `--experimental-sqlite`。
 */
export async function createAuthModule(options: CreateAuthModuleOptions = {}): Promise<AuthModule> {
  const config = options.config ?? readAuthConfig();
  if (!config.enabled) {
    const router = Router();
    router.get('/mode', (_req, res) => {
      res.json({ enabled: false });
    });
    return {
      enabled: false,
      router,
      middleware: null,
      service: null,
      database: null,
      secretKey: null,
      config,
      close: () => {},
    };
  }

  const db = options.db ?? await openAuthDatabase(config.dbPath);
  const secretKey = loadSecretBoxKey(
    options.secretKeyPath ?? path.join(path.dirname(config.dbPath), 'auth-secret.key'),
    process.env.BIOFLOW_AUTH_ENCRYPTION_KEY,
  );
  const mailer = options.mailer ?? (config.smtp ? createSmtpMailer(config.smtp) : createNullMailer());
  if (!config.smtp && !options.mailer) {
    console.warn('[auth] SMTP 未配置：注册/找回验证码将返回 503，直到补齐 BIOFLOW_AUTH_SMTP_* 环境变量。');
  }
  const service = new AuthService({ config, db, mailer, now: options.now });
  service.cleanup();

  return {
    enabled: true,
    router: createAuthRouter(service, config),
    middleware: createAuthMiddleware(service, config),
    service,
    database: db,
    secretKey,
    config,
    close: () => db.close(),
  };
}
