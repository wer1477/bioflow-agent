import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级 workspace 作用域。
 *
 * 部署版启用登录后，每个用户的会话/项目/上传都落在
 * `<BIOFLOW_WORKSPACE_DIR>/users/<userId>/` 下。为了避免把 userId 穿过
 * 每一层服务，鉴权中间件在校验会话后把该用户的根放进 AsyncLocalStorage，
 * `paths.ts` 的 getter 优先读它；没有作用域时（开发实例 / 后台任务）
 * 回退到进程默认的 workspace 根，行为与引入登录前完全一致。
 */
export interface WorkspaceScope {
  /** 该用户独占的 workspace 根（绝对路径）。 */
  root: string;
  /** 用户 id，仅用于日志/诊断。 */
  userId: string;
}

const storage = new AsyncLocalStorage<WorkspaceScope>();

export function currentWorkspaceScope(): WorkspaceScope | null {
  return storage.getStore() ?? null;
}

export function runInWorkspaceScope<T>(scope: WorkspaceScope, work: () => T): T {
  return storage.run(scope, work);
}
