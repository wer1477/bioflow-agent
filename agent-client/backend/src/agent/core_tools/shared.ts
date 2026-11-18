import path from 'node:path';
import { currentWorkspaceRoot, toolCacheDirectories } from '../../paths.js';
import { projectVenvBinPath, projectVenvEnvironment } from './project_venv.js';

export class CoreToolExecutionAbortedError extends Error {
  constructor() {
    super('Core tool execution cancelled.');
    this.name = 'AbortError';
  }
}


export function resolveTerminalPath(value: unknown, baseDir: string): string {
  const raw = String(value || '').trim();
  if (!raw) return path.resolve(baseDir);
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(baseDir, raw));
}


/**
 * Shell cwd: the project directory unless the model asked for another path.
 * There is no fallback to `BACKEND_ROOT` anymore - the project directory is the
 * only working root a session has.
 */
export function resolveShellWorkingDirectory(workdir: unknown, projectPath: string): string {
  return resolveTerminalPath(workdir, projectPath);
}


export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}


/**
 * Cache variables for tool child processes.
 *
 * Caches live under the effective workspace (`<root>/.cache/...`), which is the
 * logged-in user's own root in a deployment. Without this, every `pip`/`uv`
 * install from any user and any project lands in the shared `$HOME`, so users
 * inherit each other's packages and the host home directory grows unbounded.
 */
export function workspaceCacheEnvironment(root = currentWorkspaceRoot()): NodeJS.ProcessEnv {
  const cache = toolCacheDirectories(root);
  return {
    PIP_CACHE_DIR: cache.pip,
    UV_CACHE_DIR: cache.uv,
    XDG_CACHE_HOME: cache.xdg,
  };
}


/**
 * Environment for the child processes core tools spawn.
 *
 * The workspace's own `.bioenv/bin` is prepended so `Rscript`, `python` and `rg` resolve
 * to it even when the backend was started from a shell that never activated it —
 * `configureBioagentRuntimeEnvironment` resolves `BIOAGENT_ENV_BIN` at startup for
 * exactly this purpose.
 *
 * Both `exec_command` (which spawns `Rscript`) and the search tools (which spawn `rg`)
 * must build their environment here. They used to disagree: only the shell got the
 * bioenv on PATH, so a backend started without activation could run R but failed every
 * `glob` and `grep` with ENOENT.
 *
 * Per-workspace cache variables and the project venv are merged last so a
 * shared cache or interpreter inherited from the parent process cannot leak
 * into the child.
 */
export function toolProcessEnvironment(projectPath?: string): NodeJS.ProcessEnv {
  const nodeBin = path.dirname(process.execPath);
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const currentPath = process.env[pathKey] || process.env.PATH || '';
  const venv = projectPath ? projectVenvEnvironment(projectPath) : {};
  const pathEntries = [
    venv.VIRTUAL_ENV && projectPath ? projectVenvBinPath(projectPath) : undefined,
    process.env.BIOAGENT_ENV_BIN,
    nodeBin,
    ...currentPath.split(path.delimiter),
  ].filter((entry): entry is string => Boolean(entry));
  return {
    ...process.env,
    ...workspaceCacheEnvironment(),
    ...venv,
    [pathKey]: [...new Set(pathEntries)].join(path.delimiter),
  };
}
