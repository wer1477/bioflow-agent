#!/usr/bin/env node
/**
 * Removes the pre-project workspace layout.
 *
 * Before the project/session split, every conversation owned a folder with a
 * preset directory tree:
 *
 *   agent-client/workspace/conversations/<conversationId>/{session.json,history.jsonl,artifacts.json,transcript/,workspace/}
 *
 * That layout is gone: sessions now live in `workspace/.sessions/<projectKey>/<sessionId>/`
 * and projects are user-created directories. This script deletes the leftovers.
 *
 * Usage:
 *   node scripts/reset-legacy-workspace.mjs           # dry run: prints the manifest
 *   node scripts/reset-legacy-workspace.mjs --yes     # actually deletes
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredWorkspace = String(process.env.BIOFLOW_WORKSPACE_DIR || '').trim();
const workspaceRoot = configuredWorkspace
  ? path.resolve(path.isAbsolute(configuredWorkspace) ? configuredWorkspace : path.join(repositoryRoot, configuredWorkspace))
  : path.join(repositoryRoot, 'agent-client', 'workspace');
const legacyRoot = path.join(workspaceRoot, 'conversations');
const confirmed = process.argv.includes('--yes');

function directorySize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else {
        try {
          total += fs.statSync(entryPath).size;
        } catch { /* unreadable entries do not block the manifest */ }
      }
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

if (!fs.existsSync(legacyRoot)) {
  console.log(`Nothing to do: ${legacyRoot} does not exist.`);
  process.exit(0);
}

const entries = fs.readdirSync(legacyRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const entryPath = path.join(legacyRoot, entry.name);
    return { name: entry.name, path: entryPath, size: directorySize(entryPath) };
  })
  .sort((a, b) => b.size - a.size);

const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
console.log(`Legacy workspace: ${legacyRoot}`);
console.log(`${entries.length} conversation directories, ${formatBytes(totalBytes)} total\n`);
for (const entry of entries) console.log(`  ${formatBytes(entry.size).padStart(10)}  ${entry.name}`);

if (!confirmed) {
  console.log('\nDry run only. Re-run with --yes to delete the directories listed above.');
  process.exit(0);
}

for (const entry of entries) {
  fs.rmSync(entry.path, { recursive: true, force: true });
}
// The empty parent would otherwise be picked up as a project directory.
try {
  if (!fs.readdirSync(legacyRoot).length) fs.rmdirSync(legacyRoot);
} catch { /* the parent may already be gone */ }
console.log(`\nDeleted ${entries.length} legacy conversation directories.`);
