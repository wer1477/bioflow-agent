import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const DEFAULT_CLITOOL_SKILLS = [
  'bio-doctor',
  'bio-enrich',
  'bio-fetch',
  'bio-seq',
  'bio-variant',
  'bio-workflow',
  'bio-sc',
  'bio-bulk',
  'bio-report',
  'bio-qc',
  'bio-align',
  'bio-metagenomics',
  'science-search',
];

test('bundled Bio CLI skills are installed and bound for the lead role', () => {
  const agents = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'backend', 'config', 'agents.json'), 'utf8'));
  const bindings = new Set(agents.agents.find((agent: { id: string }) => agent.id === 'pi')?.skillIds || []);
  for (const skillId of DEFAULT_CLITOOL_SKILLS) {
    assert.equal(fs.existsSync(path.join(CLIENT_ROOT, 'skills', skillId, 'SKILL.md')), true, `${skillId} must be installed in the default skills directory`);
    assert.equal(bindings.has(skillId), true, `${skillId} must be bound to the lead role`);
  }
});

/**
 * `npm link` exposes each package's `bin` entry as a symlink to this file, and a symlink
 * only carries the target's permission bits. A 644 entry point therefore lands on PATH
 * but fails with `Permission denied` — the agent sees the command and cannot run it.
 * Windows checkout modes are not meaningful, so the guard is POSIX-only.
 */
test('bundled CLI entry points are executable and start with the node shebang', () => {
  if (process.platform === 'win32') return;
  const entryPoints: string[] = [];
  const clitoolRoot = path.join(REPO_ROOT, 'clitool');
  for (const directory of fs.readdirSync(clitoolRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const binDirectory = path.join(clitoolRoot, directory.name, 'bin');
    if (!fs.existsSync(binDirectory)) continue;
    for (const file of fs.readdirSync(binDirectory)) {
      if (file.endsWith('.js')) entryPoints.push(path.join(binDirectory, file));
    }
  }
  assert.ok(entryPoints.length >= 10, `expected the bundled CLIs, found ${entryPoints.length} entry points`);
  const nonExecutable: string[] = [];
  for (const entryPoint of entryPoints) {
    const relative = path.relative(REPO_ROOT, entryPoint);
    assert.equal(
      fs.readFileSync(entryPoint, 'utf8').split('\n', 1)[0].trim(),
      '#!/usr/bin/env node',
      `${relative} must start with the node shebang`,
    );
    if ((fs.statSync(entryPoint).mode & 0o111) === 0) nonExecutable.push(relative);
  }
  assert.deepEqual(
    nonExecutable,
    [],
    'CLI entry points must be executable, otherwise `npm link` puts a broken command on PATH. ' +
      "Fix with: git update-index --chmod=+x 'clitool/*/bin/*.js'",
  );
});

/**
 * The docs tell people to run `scripts/setup-cli-tools.sh` and `scripts/check-*.mjs`
 * directly, and every file there carries a shebang. A source checkout that lost the
 * mode bits turns those instructions into `Permission denied`, so guard the whole
 * directory rather than only the clitool packages.
 */
test('repository entry scripts are executable and declare an interpreter', () => {
  if (process.platform === 'win32') return;
  const scriptsRoot = path.join(REPO_ROOT, 'scripts');
  const entries = fs.readdirSync(scriptsRoot)
    .filter((file) => /\.(sh|mjs|py)$/.test(file))
    .map((file) => path.join(scriptsRoot, file));
  assert.ok(entries.length >= 5, `expected the repository scripts, found ${entries.length}`);
  const failures: string[] = [];
  for (const entry of entries) {
    const relative = path.relative(REPO_ROOT, entry);
    const shebang = fs.readFileSync(entry, 'utf8').split('\n', 1)[0].trim();
    if (!shebang.startsWith('#!')) failures.push(`${relative}: missing shebang`);
    if ((fs.statSync(entry).mode & 0o111) === 0) failures.push(`${relative}: not executable`);
  }
  assert.deepEqual(
    failures,
    [],
    "Entry scripts must declare a shebang and be executable. Fix with: git update-index --chmod=+x 'scripts/*.sh' 'scripts/*.mjs' 'scripts/*.py'",
  );
});
