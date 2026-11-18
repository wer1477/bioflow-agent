import { spawn } from 'node:child_process';

export const PROCESS_KILL_GRACE_MS = 3_000;

/** Terminates a detached process group without ever signalling the backend group. */
export function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    taskkill.once('error', () => {
      try { process.kill(pid, signal); } catch { /* Process has already exited. */ }
    });
    taskkill.unref();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* Process has already exited. */ }
  }
}

export function terminateProcessTreeWithGrace(pid: number | undefined): void {
  terminateProcessTree(pid, 'SIGTERM');
  const timer = setTimeout(() => terminateProcessTree(pid, 'SIGKILL'), PROCESS_KILL_GRACE_MS);
  timer.unref?.();
}
