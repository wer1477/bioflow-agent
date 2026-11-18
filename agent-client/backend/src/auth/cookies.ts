import type { Response } from 'express';
import type { AuthConfig } from './config.js';

/** Express 没有内置 cookie 解析；会话只需读一个名字，手写解析更可控。 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function setSessionCookie(res: Response, config: AuthConfig, token: string, maxAgeSeconds: number): void {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: Math.max(1, Math.floor(maxAgeSeconds)) * 1000,
  });
}

export function clearSessionCookie(res: Response, config: AuthConfig): void {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
  });
}
