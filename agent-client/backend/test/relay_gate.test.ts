import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { judgeRelay, RELAY_CONFIDENCE_FLOOR } from '../src/agent/team/relay_gate.js';

/** Point the biod config loader at a throwaway directory for the duration of one test. */
async function withBiodConfig<T>(
  config: Record<string, unknown> | null,
  callback: () => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-relay-gate-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  if (config) await writeFile(path.join(dir, 'biod.json'), JSON.stringify(config), 'utf8');
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function startSidecar(handler: (body: Record<string, unknown>) => { status: number; payload: unknown; delayMs?: number }): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const { status, payload, delayMs } = handler(body);
      const send = () => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (delayMs) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function enabledConfig(baseUrl: string): Record<string, unknown> {
  return { schemaVersion: 1, enabled: true, service: { baseUrl }, state: { maxChars: 220 } };
}

test('a disabled sidecar escalates instead of blocking', async () => {
  await withBiodConfig(null, async () => {
    const verdict = await judgeRelay({ from: 'searcher', to: 'writer', body: '需要对照组的样本量' });
    assert.equal(verdict.verdict, 'escalate');
    assert.equal(verdict.source, 'disabled');
  });
});

test('a confident allow passes, and the three reasons are carried through', async () => {
  const sidecar = await startSidecar(() => ({
    status: 200,
    payload: {
      verdict: 'allow',
      confidence: 0.92,
      reasons: { necessity: '缺少对照组', appropriateness: 'writer 负责成稿', risk: '无冲突' },
    },
  }));
  try {
    await withBiodConfig(enabledConfig(sidecar.baseUrl), async () => {
      const verdict = await judgeRelay({ from: 'searcher', to: 'writer', body: '需要对照组的样本量', why: '结论不一致' });
      assert.equal(verdict.verdict, 'allow');
      assert.equal(verdict.source, 'biod');
      assert.ok(verdict.reasons.some((reason) => reason.includes('necessity')), verdict.reasons.join('|'));
    });
  } finally {
    sidecar.server.close();
  }
});

test('confidence below the floor escalates even when the sidecar says allow', async () => {
  const sidecar = await startSidecar(() => ({ status: 200, payload: { verdict: 'allow', confidence: RELAY_CONFIDENCE_FLOOR - 0.2 } }));
  try {
    await withBiodConfig(enabledConfig(sidecar.baseUrl), async () => {
      const verdict = await judgeRelay({ from: 'searcher', to: 'writer', body: 'x' });
      assert.equal(verdict.verdict, 'escalate');
      assert.equal(verdict.source, 'low_confidence');
    });
  } finally {
    sidecar.server.close();
  }
});

test('a rejection is reported as a rejection, with reasons', async () => {
  const sidecar = await startSidecar(() => ({ status: 200, payload: { verdict: 'reject', confidence: 0.88, reasons: ['两个角色之间不需要直接沟通'] } }));
  try {
    await withBiodConfig(enabledConfig(sidecar.baseUrl), async () => {
      const verdict = await judgeRelay({ from: 'searcher', to: 'writer', body: 'x' });
      assert.equal(verdict.verdict, 'reject');
      assert.deepEqual(verdict.reasons, ['两个角色之间不需要直接沟通']);
    });
  } finally {
    sidecar.server.close();
  }
});

test('an unreachable, slow or misbehaving sidecar fails open to the lead', async () => {
  const failing = await startSidecar(() => ({ status: 500, payload: { error: 'boom' } }));
  try {
    await withBiodConfig(enabledConfig(failing.baseUrl), async () => {
      assert.equal((await judgeRelay({ from: 'searcher', to: 'writer', body: 'x' })).source, 'http_500');
    });
  } finally {
    failing.server.close();
  }

  const slow = await startSidecar(() => ({ status: 200, payload: { verdict: 'allow', confidence: 0.99 }, delayMs: 400 }));
  try {
    await withBiodConfig(enabledConfig(slow.baseUrl), async () => {
      const verdict = await judgeRelay({ from: 'searcher', to: 'writer', body: 'x' }, { timeoutMs: 50 });
      assert.equal(verdict.verdict, 'escalate');
      assert.equal(verdict.source, 'timeout');
    });
  } finally {
    slow.server.close();
  }

  const nonsense = await startSidecar(() => ({ status: 200, payload: { verdict: 'maybe', confidence: 0.9 } }));
  try {
    await withBiodConfig(enabledConfig(nonsense.baseUrl), async () => {
      assert.equal((await judgeRelay({ from: 'searcher', to: 'writer', body: 'x' })).source, 'unknown_verdict');
    });
  } finally {
    nonsense.server.close();
  }
});
