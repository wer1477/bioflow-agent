import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentWorkspaceScope } from './workspace_scope.js';

/**
 * Single source of truth for module-relative roots.
 *
 * This module lives directly under `src/` and, after `tsc`, directly under
 * `dist/`, so it always sits exactly one level below `backend/`. Every root
 * below is derived from that one fixed depth, which keeps `tsx src/index.ts`
 * and `node dist/index.js` resolving to the same directories.
 *
 * Do not reintroduce per-file `path.resolve(dirname, '..', ...)` chains: one
 * wrong `'..'` silently relocates runtime state outside the documented
 * workspace directory.
 *
 * The workspace root is the one root that a deployment may relocate:
 * `BIOFLOW_WORKSPACE_DIR` overrides it (relative values resolve against the
 * repository root). In a login-enabled deployment the *effective* root is
 * per user (see `workspace_scope.ts`), so callers must use the getters below
 * rather than the base constants.
 */
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** `agent-client/backend` - the agent runtime boundary. */
export const BACKEND_ROOT = path.resolve(MODULE_DIRECTORY, '..');

/** `agent-client` - shared source: `backend/`, `web/`, `skills/`, `knowledgebase/`, `toollibrary/`, `workspace/`. */
export const AGENT_CLIENT_ROOT = path.resolve(BACKEND_ROOT, '..');

/** Repository root that contains `agent-client/` and `clitool/`. */
export const REPOSITORY_ROOT = path.resolve(AGENT_CLIENT_ROOT, '..');

/** Shared runtime configuration: `agent-client/backend/config`. */
export const CONFIG_ROOT = path.join(BACKEND_ROOT, 'config');

/** Shared Skill definitions: `agent-client/skills`. */
export const SKILLS_ROOT = path.join(AGENT_CLIENT_ROOT, 'skills');

/** Human-curated knowledge base: `agent-client/knowledgebase`. */
export const KNOWLEDGEBASE_ROOT = path.join(AGENT_CLIENT_ROOT, 'knowledgebase');

/** Curated two-level capability catalog: `agent-client/toollibrary`. */
export const TOOLLIBRARY_ROOT = path.join(AGENT_CLIENT_ROOT, 'toollibrary');

/**
 * Base local-state root, i.e. the process default before per-user scoping.
 * Holds the single-instance lock and, in login-enabled deployments, the
 * `users/<userId>/` subdirectories. Data paths must use the getters below.
 */
export const WORKSPACE_ROOT = resolveWorkspaceRoot();

/** 进程级内核/后台任务登记表的根，不属于任何单个用户的数据。 */
export const RUNTIME_STATE_ROOT = path.join(WORKSPACE_ROOT, '.runtime');

/** Internal workspace entries that can never be a project directory name. */
export const RESERVED_WORKSPACE_ENTRIES = ['.sessions', '.trash', '.runtime', '.cache', '.projects.json', 'users'] as const;

/**
 * Effective workspace root of the current request: the authenticated user's
 * own root when login is enabled, otherwise the process default.
 */
export function currentWorkspaceRoot(): string {
  return currentWorkspaceScope()?.root ?? WORKSPACE_ROOT;
}

/** Central session store: `<root>/.sessions/<projectKey>/<sessionId>/`. */
export function sessionsRoot(root = currentWorkspaceRoot()): string {
  return path.join(root, '.sessions');
}

/** Removed projects are moved here instead of being deleted. */
export function trashRoot(root = currentWorkspaceRoot()): string {
  return path.join(root, '.trash');
}

/** Rebuildable cache of project identities: `<root>/.projects.json`. */
export function projectsIndexFile(root = currentWorkspaceRoot()): string {
  return path.join(root, '.projects.json');
}

/** Per-workspace runtime scratch space: `<root>/.runtime`. */
export function runtimeStateRoot(root = currentWorkspaceRoot()): string {
  return path.join(root, '.runtime');
}

/**
 * In-flight chunked uploads: `<root>/.runtime/uploads/<uploadId>/`.
 * Kept inside the workspace so the completed file can be renamed into a
 * project without crossing filesystems, and outside the project tree so
 * half-uploaded files are never visible to the agent or the file browser.
 */
export function uploadsRoot(root = currentWorkspaceRoot()): string {
  return path.join(runtimeStateRoot(root), 'uploads');
}

/**
 * Per-workspace tool caches. `pip`, `uv` and XDG-aware tools write here instead
 * of the shared `$HOME`, so one user's installs do not seed another user's
 * cache (or fill the host home directory).
 */
export function cacheRoot(root = currentWorkspaceRoot()): string {
  return path.join(root, '.cache');
}

export function toolCacheDirectories(root = currentWorkspaceRoot()): { pip: string; uv: string; xdg: string } {
  const base = cacheRoot(root);
  return {
    pip: path.join(base, 'pip'),
    uv: path.join(base, 'uv'),
    xdg: path.join(base, 'xdg'),
  };
}

/**
 * Creates the internal workspace roots that the backend expects to exist.
 * Project directories are never created here: they belong to the user.
 */
export function ensureStateRoots(root = currentWorkspaceRoot()): void {
  fs.mkdirSync(sessionsRoot(root), { recursive: true });
  fs.mkdirSync(uploadsRoot(root), { recursive: true });
  for (const directory of Object.values(toolCacheDirectories(root))) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function resolveWorkspaceRoot(): string {
  const configured = String(process.env.BIOFLOW_WORKSPACE_DIR || '').trim();
  if (!configured) return path.join(AGENT_CLIENT_ROOT, 'workspace');
  return path.resolve(path.isAbsolute(configured) ? configured : path.join(REPOSITORY_ROOT, configured));
}
