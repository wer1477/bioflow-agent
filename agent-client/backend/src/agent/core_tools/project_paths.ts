import path from 'node:path';
import type { CoreToolExecutionContext } from '../core_tools_runtime.js';
import { isInsideProject } from '../config/project_files.js';

/**
 * The agent's working root is the *project directory* bound to the session.
 * There is deliberately no fallback to `BACKEND_ROOT`: before this change the
 * file and search tools defaulted to the backend source directory, so the
 * "project" boundary did not exist at all.
 */
export function resolveToolRoot(context: CoreToolExecutionContext): string {
  const projectPath = String(context.projectPath || '').trim();
  if (!projectPath) throw new Error('This session is not bound to a project directory.');
  return path.resolve(projectPath);
}

/** Resolves a tool path argument against the project root. */
export function resolveToolPath(projectPath: string, value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return path.resolve(projectPath);
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(projectPath, raw));
}

/** Resolution plus the containment verdict used by the security gate. */
export function inspectToolPath(projectPath: string, value: unknown): { path: string; inside: boolean } {
  const resolved = resolveToolPath(projectPath, value);
  return { path: resolved, inside: isInsideProject(projectPath, resolved) };
}

export function assertToolPath(projectPath: string, target: string, label: string): string {
  if (!isInsideProject(projectPath, target)) throw new Error(`${label} is outside the project directory.`);
  return target;
}
