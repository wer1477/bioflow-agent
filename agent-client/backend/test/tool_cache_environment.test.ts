import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { toolProcessEnvironment, workspaceCacheEnvironment } from '../src/agent/core_tools/shared.js';
import { ensureStateRoots, toolCacheDirectories } from '../src/paths.js';
import { runInWorkspaceScope } from '../src/workspace_scope.js';

function temporaryRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bioflow-cache-${label}-`));
}

test('workspaceCacheEnvironment keeps pip/uv/XDG caches under the workspace root', () => {
  const root = path.join(os.tmpdir(), `bioflow-cache-layout-${process.pid}`);
  const env = workspaceCacheEnvironment(root);
  assert.equal(env.PIP_CACHE_DIR, path.join(root, '.cache', 'pip'));
  assert.equal(env.UV_CACHE_DIR, path.join(root, '.cache', 'uv'));
  assert.equal(env.XDG_CACHE_HOME, path.join(root, '.cache', 'xdg'));
});

test('toolProcessEnvironment follows the current workspace scope and overrides inherited cache paths', () => {
  const firstRoot = temporaryRoot('first');
  const secondRoot = temporaryRoot('second');
  const previous = {
    PIP_CACHE_DIR: process.env.PIP_CACHE_DIR,
    UV_CACHE_DIR: process.env.UV_CACHE_DIR,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  process.env.PIP_CACHE_DIR = '/shared/pip';
  process.env.UV_CACHE_DIR = '/shared/uv';
  process.env.XDG_CACHE_HOME = '/shared/xdg';
  try {
    runInWorkspaceScope({ root: firstRoot, userId: 'user-a' }, () => {
      ensureStateRoots(firstRoot);
      const env = toolProcessEnvironment();
      assert.equal(env.PIP_CACHE_DIR, path.join(firstRoot, '.cache', 'pip'));
      assert.equal(env.UV_CACHE_DIR, path.join(firstRoot, '.cache', 'uv'));
      assert.equal(env.XDG_CACHE_HOME, path.join(firstRoot, '.cache', 'xdg'));
      for (const directory of Object.values(toolCacheDirectories(firstRoot))) {
        assert.equal(fs.existsSync(directory), true, `${directory} should exist`);
      }
    });

    runInWorkspaceScope({ root: secondRoot, userId: 'user-b' }, () => {
      const env = toolProcessEnvironment();
      assert.equal(env.PIP_CACHE_DIR, path.join(secondRoot, '.cache', 'pip'));
      assert.notEqual(env.PIP_CACHE_DIR, path.join(firstRoot, '.cache', 'pip'));
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});
