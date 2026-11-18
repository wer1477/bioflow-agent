export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled';
export type CodePurpose = 'register' | 'reset';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  sessionId: string;
  user: AuthUser;
  expiresAt: string;
  maxAgeSeconds: number;
}

export interface SessionLookup extends SessionInfo {
  /** 本次请求是否顺延了会话有效期（需要重写 cookie）。 */
  extended: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      authSessionId?: string;
    }
  }
}
