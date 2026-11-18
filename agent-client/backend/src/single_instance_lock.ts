import fs from 'node:fs';
import path from 'node:path';

let lockPath: string | null = null;

/**
 * Bioflow's file-backed conversation store is intentionally single-process.
 * Refuse a second local backend before it can use a stale in-memory cache.
 */
export function acquireSingleInstanceLock(workspaceRoot: string): void {
  if (lockPath) return;
  const target = path.join(workspaceRoot, '.bioflow-backend.lock');
  fs.mkdirSync(workspaceRoot, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(target, 'wx');
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(descriptor);
      lockPath = target;
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const ownerPid = readOwnerPid(target);
      if (ownerPid && isProcessRunning(ownerPid)) {
        throw new Error(`Bioflow is already running (pid ${ownerPid}) and owns ${target}. Only one backend process may use this workspace.`);
      }
      // The exact lock file belongs to a dead process. Remove only this stale
      // sentinel and retry the exclusive create once.
      fs.rmSync(target, { force: true });
    }
  }
  throw new Error(`Unable to acquire the Bioflow single-instance lock at ${target}.`);
}

export function releaseSingleInstanceLock(): void {
  if (!lockPath) return;
  fs.rmSync(lockPath, { force: true });
  lockPath = null;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

function readOwnerPid(filePath: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { pid?: unknown };
    const pid = Number(parsed.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
