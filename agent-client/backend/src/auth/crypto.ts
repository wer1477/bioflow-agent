import crypto from 'node:crypto';

/** 会话 token：32 字节随机数，base64url 编码后放进 httpOnly cookie。 */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 数据库只保存 token 的 sha256，泄库也无法直接重放会话。 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomNumericCode(length = 6): string {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

const CODE_SCRYPT = { N: 16384, r: 8, p: 1 } as const;

/** 验证码只存 scrypt 哈希；6 位数字 + 单次使用 + 5 次错误上限。 */
export function hashVerificationCode(email: string, purpose: string, code: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(`${email}|${purpose}|${code}`, salt, 32, CODE_SCRYPT);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyVerificationCode(stored: string, email: string, purpose: string, code: string): boolean {
  const separator = stored.indexOf(':');
  if (separator <= 0) return false;
  const salt = Buffer.from(stored.slice(0, separator), 'hex');
  const expected = Buffer.from(stored.slice(separator + 1), 'hex');
  if (!salt.length || expected.length !== 32) return false;
  const actual = crypto.scryptSync(`${email}|${purpose}|${code}`, salt, 32, CODE_SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}
