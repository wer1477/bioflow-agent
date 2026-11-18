import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relative) {
  return fs.readFileSync(path.join(backendRoot, relative), 'utf8');
}

test('the entrypoint loads the env file before resolving module roots', () => {
  const entrypoint = readSource('src/index.ts');

  // The env path is derived from this module, not from `environment_file_store.ts`:
  // importing that helper pulls in `paths.ts`, which freezes WORKSPACE_ROOT before
  // dotenv has had a chance to apply `BIOFLOW_WORKSPACE_DIR`.
  assert.match(entrypoint, /const defaultEnvFile = path\.join\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.env'\);/);
  assert.match(entrypoint, /loadDotenv\(\{ path: path\.resolve\(process\.env\.BIOFLOW_ENV_FILE \|\| defaultEnvFile\) \}\)/);
  assert.match(entrypoint, /const \{ startHttpServer \} = await import\('\.\/http\/server\.js'\);/);
  assert.doesNotMatch(entrypoint, /^import .*environment_file_store/m);
  assert.doesNotMatch(entrypoint, /^import .*http\/server/m);
});

test('the workspace root is derived from BIOFLOW_WORKSPACE_DIR', () => {
  const source = readSource('src/paths.ts');
  assert.match(source, /process\.env\.BIOFLOW_WORKSPACE_DIR/);
  assert.match(source, /export const WORKSPACE_ROOT = resolveWorkspaceRoot\(\);/);
});
