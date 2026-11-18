import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * Argon2id（OWASP 推荐参数：m=19 MiB, t=2, p=1）。
 *
 * 用户明确要求 argon2id；目标服务器已安装 `@node-rs/argon2`（预编译、无 node-gyp），
 * 安装失败时的备选是 bcrypt cost 12 —— 见 docs/development.md。
 */
const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(passwordHash, password);
  } catch {
    return false;
  }
}
