import type { AuthModule } from './index.js';

/**
 * 进程内唯一的鉴权模块引用。
 *
 * LLM 解析发生在请求处理链深处（agent_context_resolver），把 AuthModule 一路传下去
 * 会污染所有签名；启动时注册一次，按当前 workspace 作用域取用户级 provider。
 */
let current: AuthModule | null = null;

export function setAuthModule(module: AuthModule | null): void {
  current = module;
}

export function getAuthModule(): AuthModule | null {
  return current;
}
