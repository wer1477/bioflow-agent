import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * 用户 LLM API key 的静态加密：AES-256-GCM。
 *
 * 主密钥优先取 `BIOFLOW_AUTH_ENCRYPTION_KEY`（base64，32 字节）；否则在鉴权数据库
 * 同级生成 `auth-secret.key`（0600）。密钥不写进数据库，单纯拷走 auth.sqlite
 * 无法解出任何用户 key。
 */
export function loadSecretBoxKey(keyFilePath: string, configuredBase64?: string): Buffer {
  const configured = String(configuredBase64 || '').trim();
  if (configured) {
    const key = Buffer.from(configured, 'base64');
    if (key.length !== KEY_BYTES) throw new Error('BIOFLOW_AUTH_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
    return key;
  }
  try {
    const existing = fs.readFileSync(keyFilePath);
    if (existing.length === KEY_BYTES) return existing;
  } catch {
    // Missing or unreadable: generate a fresh key below.
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFilePath, key, { mode: 0o600 });
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptSecret(key: Buffer, payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('Encrypted secret is malformed.');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
