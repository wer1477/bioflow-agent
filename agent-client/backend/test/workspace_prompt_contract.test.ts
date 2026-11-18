import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

test('the lead prompt describes the project workspace instead of a preset layout', () => {
  const prompt = readSource('config/prompts/pi.md');

  assert.match(prompt, /项目目录/);
  assert.match(prompt, /初始为空/);
  assert.doesNotMatch(prompt, /你的工作目录是workspace：/);
  assert.doesNotMatch(prompt, /runs里面有Data/);
});

test('the backend never materialises a preset project layout', () => {
  const projectFiles = readSource('src/agent/config/project_files.ts');
  assert.doesNotMatch(projectFiles, /'runs', 'Data'/);
  assert.doesNotMatch(projectFiles, /'user'\)/);

  // Building the system prompt used to call ensureConversationWorkspace, which
  // created six preset directories just by sending a message.
  const resolver = readSource('src/agent/service/agent_context_resolver.ts');
  assert.doesNotMatch(resolver, /ensureConversationWorkspace/);
  assert.doesNotMatch(resolver, /workspace_store/);
});

test('session state lives in the central store, not inside project directories', () => {
  const sessionPaths = readSource('src/agent/config/session_paths.ts');
  assert.match(sessionPaths, /sessionsRoot\(\)/);
  assert.match(sessionPaths, /'session\.json'/);
  assert.match(sessionPaths, /'transcript'/);
  assert.match(sessionPaths, /'artifacts\.json'/);

  const conversationStore = readSource('src/agent/config/conversation_file_store.ts');
  assert.doesNotMatch(conversationStore, /CONVERSATIONS_ROOT/);
  assert.match(conversationStore, /listRecords/);
});
