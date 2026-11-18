import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isBiodDisabledByEnv, loadBiodConfig } from '../src/agent/biod/config.js';

/** Every case gets its own throwaway config directory; nothing reads the developer's env. */
function withConfigDir(
  contents: string | undefined,
  run: (directory: string) => void,
  fileName = 'biod.json',
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-config-'));
  try {
    if (contents !== undefined) fs.writeFileSync(path.join(directory, fileName), contents);
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function completeConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    enabled: true,
    service: { baseUrl: 'http://127.0.0.1:9999', autoStart: true, startupTimeoutMs: 12345, requestTimeoutMs: 111, contextTimeoutMs: 222 },
    runtime: { python: '/opt/py', repoRoot: '/opt/repo', ckptDir: '/opt/ckpt', device: 'cpu', dtype: 'float32' },
    model: { expectedVersion: 'biod-test' },
    decisionPoints: {
      tool_select: { mode: 'select', tau: 0.7 },
      kb_select: { mode: 'select', tau: 0.6, topK: 5 },
      context_retention: { mode: 'select', maxGroups: 8 },
    },
    state: { maxChars: 1500 },
  };
}

test('a missing biod.json falls back to the disabled safe default instead of throwing', () => {
  withConfigDir(undefined, (directory) => {
    const config = loadBiodConfig(directory, {});
    assert.equal(config.enabled, false);
    assert.equal(config.service.autoStart, false);
    assert.equal(config.decisionPoints.tool_select.mode, 'off');
    assert.equal(config.decisionPoints.kb_select.mode, 'off');
    assert.equal(config.decisionPoints.context_retention.mode, 'off');
    assert.equal(config.service.baseUrl, 'http://127.0.0.1:8790');
    assert.equal(config.state.maxChars, 2000);
    assert.ok(config.warnings.some((warning) => warning.includes('biod.json')));
  });
});

test('invalid JSON falls back to the disabled safe default and reports the file', () => {
  withConfigDir('{ this is not json', (directory) => {
    const config = loadBiodConfig(directory, {});
    assert.equal(config.enabled, false);
    assert.ok(config.warnings.some((warning) => warning.includes('biod.json')));
  });
});

test('the shipped biod.json parses with its documented decision points', () => {
  const configDirectory = fileURLToPath(new URL('../config', import.meta.url));
  const config = loadBiodConfig(configDirectory, {});
  assert.equal(config.enabled, true);
  assert.deepEqual(config.decisionPoints.tool_select, { mode: 'off', tau: 0.1 });
  assert.deepEqual(config.decisionPoints.kb_select, { mode: 'select', tau: 0.1078, topK: 3 });
  assert.deepEqual(config.decisionPoints.context_retention, { mode: 'select', maxGroups: 12 });
  assert.deepEqual(config.decisionPoints.role_select, { mode: 'select', tau: 0.6 });
  assert.deepEqual(config.decisionPoints.relay_select, { mode: 'select', floor: 0.75 });
  assert.equal(config.model.expectedVersion, 'biod-mt-v2');
  assert.equal(config.runtime.entry, 'biod.multitask.serve');
  assert.equal(config.state.maxChars, 640);
  // The shipped runtime paths are ${ENV} references; without them autoStart cannot work,
  // but an already-running sidecar may still be adopted.
  assert.equal(config.runtime.python, undefined);
  assert.equal(config.runtime.repoRoot, undefined);
  assert.equal(config.runtime.ckptDir, undefined);
  assert.equal(config.service.autoStart, false);
  assert.ok(config.warnings.some((warning) => warning.includes('autoStart')));
});

test('${ENV} references resolve from the supplied environment and missing ones become undefined', () => {
  const withReferences = completeConfig();
  withReferences.runtime = {
    python: '${BIOD_TEST_PYTHON}',
    repoRoot: '${BIOD_TEST_REPO}',
    ckptDir: '${BIOD_TEST_CKPT}',
    device: 'cpu',
    dtype: 'float32',
  };
  withConfigDir(JSON.stringify(withReferences), (directory) => {
    const resolved = loadBiodConfig(directory, { BIOD_TEST_PYTHON: '/env/py', BIOD_TEST_REPO: '/env/repo', BIOD_TEST_CKPT: '/env/ckpt' });
    assert.equal(resolved.runtime.python, '/env/py');
    assert.equal(resolved.runtime.repoRoot, '/env/repo');
    assert.equal(resolved.runtime.ckptDir, '/env/ckpt');
    assert.equal(resolved.service.autoStart, true);

    const missing = loadBiodConfig(directory, { BIOD_TEST_PYTHON: '/env/py' });
    assert.equal(missing.runtime.python, '/env/py');
    assert.equal(missing.runtime.repoRoot, undefined);
    assert.equal(missing.runtime.ckptDir, undefined);
    assert.equal(missing.service.autoStart, false);
    assert.ok(missing.warnings.some((warning) => warning.includes('BIOD_TEST_REPO')));
  });
});

test('unknown fields are reported as warnings instead of silently ignored', () => {
  const unknown = completeConfig();
  unknown.mysteryTopLevel = true;
  (unknown.service as Record<string, unknown>).mysteryService = 1;
  const points = unknown.decisionPoints as Record<string, Record<string, unknown>>;
  points.tool_select.noToolMarging = 0.3;
  withConfigDir(JSON.stringify(unknown), (directory) => {
    const config = loadBiodConfig(directory, {});
    assert.equal(config.enabled, true);
    assert.ok(config.warnings.some((warning) => warning === 'biod.mysteryTopLevel: unknown field ignored.'));
    assert.ok(config.warnings.some((warning) => warning === 'biod.service.mysteryService: unknown field ignored.'));
    assert.ok(config.warnings.some((warning) => warning === 'biod.decisionPoints.tool_select.noToolMarging: unknown field ignored.'));
  });
});

test('fields of the wrong type fall back per field and never disable the file', () => {
  const broken = completeConfig();
  broken.enabled = 'yes';
  broken.service = { baseUrl: 'not a url', autoStart: 'true', startupTimeoutMs: -5, requestTimeoutMs: 1.5, contextTimeoutMs: null };
  (broken.decisionPoints as Record<string, Record<string, unknown>>).tool_select = { mode: 'sometimes', tau: 2, noToolMargin: -1 };
  broken.state = { maxChars: 0 };
  withConfigDir(JSON.stringify(broken), (directory) => {
    const config = loadBiodConfig(directory, {});
    assert.equal(config.enabled, false);
    assert.equal(config.service.baseUrl, 'http://127.0.0.1:8790');
    assert.equal(config.service.autoStart, false);
    assert.equal(config.service.startupTimeoutMs, 180000);
    assert.equal(config.decisionPoints.tool_select.mode, 'off');
    assert.equal(config.decisionPoints.tool_select.tau, 0.5);
    assert.equal(config.state.maxChars, 2000);
    assert.ok(config.warnings.length >= 5);
  });
});

test('isBiodDisabledByEnv only honours 1/true', () => {
  assert.equal(isBiodDisabledByEnv({ BIOFLOW_BIOD_DISABLED: '1' }), true);
  assert.equal(isBiodDisabledByEnv({ BIOFLOW_BIOD_DISABLED: 'true' }), true);
  assert.equal(isBiodDisabledByEnv({ BIOFLOW_BIOD_DISABLED: 'TRUE' }), true);
  assert.equal(isBiodDisabledByEnv({ BIOFLOW_BIOD_DISABLED: '0' }), false);
  assert.equal(isBiodDisabledByEnv({ BIOFLOW_BIOD_DISABLED: '' }), false);
  assert.equal(isBiodDisabledByEnv({}), false);
});
