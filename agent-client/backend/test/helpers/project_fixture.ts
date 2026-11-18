import fs from 'node:fs';
import path from 'node:path';
import { currentWorkspaceRoot } from '../../src/paths.js';

/**
 * Test fixtures must never create a *visible* project directory: hidden
 * entries are excluded from project discovery, so a dot-prefixed directory
 * keeps the developer's real workspace clean even if a test crashes.
 */
export interface TempProject {
  projectPath: string;
  cleanup(): void;
}

export function createTempProject(prefix = 'test'): TempProject {
  const name = `.${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const projectPath = path.join(currentWorkspaceRoot(), name);
  fs.mkdirSync(projectPath, { recursive: true });
  return {
    projectPath,
    cleanup() {
      fs.rmSync(projectPath, { recursive: true, force: true });
    },
  };
}
