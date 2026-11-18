import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT } from './paths.js';

export const BIOAGENT_ENV_BIN = 'BIOAGENT_ENV_BIN';

export function configureBioagentRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  repositoryRoot = REPOSITORY_ROOT,
): void {
  const configured = environment[BIOAGENT_ENV_BIN];
  const candidate = configured || path.join(repositoryRoot, '.bioenv', 'bin');
  if (path.isAbsolute(candidate) && isDirectory(candidate)) {
    environment[BIOAGENT_ENV_BIN] = candidate;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
