import { spawn } from 'node:child_process';

const MAX_CAPTURED_OUTPUT = 16 * 1024;

function capture(stream) {
  let value = '';
  stream?.on('data', (chunk) => { if (value.length < MAX_CAPTURED_OUTPUT) value += String(chunk).slice(0, MAX_CAPTURED_OUTPUT - value.length); });
  return () => value;
}

export class CommandError extends Error {
  constructor(command, args, message) {
    super(message);
    this.command = command;
    this.args = args;
  }
}

export function createRunner({ spawnImpl = spawn } = {}) {
  return {
    run(command, args, { cwd } = {}) {
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnImpl(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          reject(new CommandError(command, args, error instanceof Error ? error.message : String(error)));
          return;
        }
        const stdout = capture(child.stdout);
        const stderr = capture(child.stderr);
        child.once('error', (error) => reject(new CommandError(command, args, error.code === 'ENOENT' ? `Required executable "${command}" was not found on PATH.` : (error instanceof Error ? error.message : String(error)))));
        child.once('close', (code) => {
          if (code === 0) resolve({ stdout: stdout().trim(), stderr: stderr().trim() });
          else reject(new CommandError(command, args, `${command} exited with status ${code}.${stderr() ? ` ${stderr().trim()}` : ''}`));
        });
      });
    },
  };
}
