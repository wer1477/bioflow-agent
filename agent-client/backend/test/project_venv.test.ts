import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  basePythonPath,
  ensureProjectVenv,
  projectRLibraryPath,
  projectVenvBinPath,
  projectVenvEnabled,
  projectVenvEnvironment,
  projectVenvPythonPath,
} from '../src/agent/core_tools/project_venv.js';
import { toolProcessEnvironment } from '../src/agent/core_tools/shared.js';

const baseAvailable = Boolean(basePythonPath());

function temporaryProject(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bioflow-venv-${label}-`));
}

async function withFlag<T>(value: string | undefined, work: () => Promise<T>): Promise<T> {
  const previous = process.env.BIOFLOW_PROJECT_VENV;
  if (value === undefined) delete process.env.BIOFLOW_PROJECT_VENV;
  else process.env.BIOFLOW_PROJECT_VENV = value;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_PROJECT_VENV;
    else process.env.BIOFLOW_PROJECT_VENV = previous;
  }
}

test('flag off keeps the shared environment and never creates a venv', async () => {
  await withFlag(undefined, async () => {
    const root = temporaryProject('off');
    try {
      assert.equal(projectVenvEnabled(), false);
      assert.deepEqual(projectVenvEnvironment(root), {});
      assert.equal(await ensureProjectVenv(root), null);
      assert.equal(fs.existsSync(path.join(root, '.venv')), false);
      const env = toolProcessEnvironment(root);
      assert.equal(env.VIRTUAL_ENV, process.env.VIRTUAL_ENV);
      assert.equal(env.PIP_USER, process.env.PIP_USER);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('flag on without a base interpreter falls back to the shared environment', async () => {
  const previous = process.env.BIOAGENT_ENV_BIN;
  delete process.env.BIOAGENT_ENV_BIN;
  try {
    await withFlag('1', async () => {
      const root = temporaryProject('nobase');
      try {
        assert.equal(await ensureProjectVenv(root), null);
        assert.deepEqual(projectVenvEnvironment(root), {});
        assert.equal(fs.existsSync(path.join(root, '.venv')), false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  } finally {
    if (previous === undefined) delete process.env.BIOAGENT_ENV_BIN;
    else process.env.BIOAGENT_ENV_BIN = previous;
  }
});

test('project venv inherits shared packages and takes precedence in tool environments', { skip: !baseAvailable }, async () => {
  await withFlag('1', async () => {
    const root = temporaryProject('on');
    try {
      const venv = await ensureProjectVenv(root);
      assert.equal(venv, path.join(root, '.venv'));
      assert.equal(fs.existsSync(projectVenvPythonPath(root)), true);
      assert.equal(fs.existsSync(projectRLibraryPath(root)), true);

      const env = projectVenvEnvironment(root);
      assert.equal(env.VIRTUAL_ENV, venv);
      assert.equal(env.PYTHONNOUSERSITE, '1');
      assert.equal(env.PIP_REQUIRE_VIRTUALENV, 'true');
      assert.equal(env.PIP_USER, '0');
      assert.equal(env.UV_PROJECT_ENVIRONMENT, venv);
      assert.equal(env.R_LIBS_USER, projectRLibraryPath(root));

      const toolEnv = toolProcessEnvironment(root);
      assert.equal(toolEnv.PATH?.split(path.delimiter)[0], projectVenvBinPath(root));

      const probe = spawnSync(
        projectVenvPythonPath(root),
        ['-c', 'import sys, pandas; print(sys.prefix); print(pandas.__version__)'],
        { encoding: 'utf8', env: { ...process.env, ...toolEnv } },
      );
      assert.equal(probe.status, 0, probe.stderr);
      const [prefix, version] = probe.stdout.trim().split('\n');
      assert.equal(prefix, venv);
      assert.match(version, /^\d+\./);

      const concurrent = await Promise.all([ensureProjectVenv(root), ensureProjectVenv(root)]);
      assert.deepEqual(concurrent, [venv, venv]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
