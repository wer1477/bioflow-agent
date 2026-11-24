import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { HttpBiodClient } from '../src/agent/biod/client.js';
import type { BiodCandidate, BiodFailure, BiodResult } from '../src/agent/biod/types.js';

/**
 * The client is exercised against a real local HTTP server (never the 8790 sidecar), so the
 * timeout, socket, status-code and JSON paths are the same ones production runs.
 */

interface TestServer {
  baseUrl: string;
  requests: Array<{ url: string; body: string }>;
  close(): Promise<void>;
}

async function startServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void | Promise<void>,
): Promise<TestServer> {
  const requests: Array<{ url: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      requests.push({ url: request.url ?? '', body });
      try {
        await handler(request, response, body);
      } catch {
        if (!response.writableEnded) response.destroy();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function clientFor(server: TestServer, overrides: { requestTimeoutMs?: number; contextTimeoutMs?: number; circuitOpenMs?: number } = {}): HttpBiodClient {
  return new HttpBiodClient({
    baseUrl: server.baseUrl,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 200,
    contextTimeoutMs: overrides.contextTimeoutMs ?? 200,
    circuitOpenMs: overrides.circuitOpenMs,
  });
}

function assertFailure<T>(result: BiodResult<T>): asserts result is BiodFailure {
  const failure = result as { ok?: unknown };
  if (failure.ok !== false) assert.fail('expected the biod call to fail');
}

function assertSuccess<T extends { ok: true }>(result: BiodResult<T>): asserts result is T {
  if (result.ok !== true) assert.fail(`expected the biod call to succeed, got ${String((result as BiodFailure).reason)}`);
}

const candidates: BiodCandidate[] = [
  { id: 'skill:exec', name: 'exec', description: 'run a command', kind: 'skill' },
  { id: 'mcp:fs', name: 'fs', description: 'read files', kind: 'mcp' },
];

const toolDecision = {
  ok: true,
  decisionId: 'decision-1',
  kind: 'tool',
  modelVersion: 'biod-v0-final+abc',
  candidateCount: 2,
  scores: [
    { id: 'skill:exec', p: 0.91 },
    { id: 'mcp:fs', p: 0.09 },
  ],
  chosen: ['skill:exec'],
  confidence: 0.91,
  noToolProb: 0.02,
  latencyMs: 420,
  warnings: [],
};

test('health and version are parsed without throwing', async () => {
  const server = await startServer((request, response) => {
    if (request.url === '/v1/health') {
      sendJson(response, 200, { ok: true, status: 'ready', modelVersion: 'biod-v0-final' });
      return;
    }
    sendJson(response, 200, { ok: true, modelVersion: 'biod-v0-final', optionIds: { tool: ['a'], kb: ['b'] } });
  });
  try {
    const client = clientFor(server);
    assert.deepEqual(await client.health(), { ok: true, status: 'ready', modelVersion: 'biod-v0-final', error: undefined });
    assert.deepEqual(await client.version(), { ok: true, modelVersion: 'biod-v0-final', optionIds: { tool: ['a'], kb: ['b'] }, supportsCandidateDescriptions: false, error: undefined });
  } finally {
    await server.close();
  }
});

test('decideTool maps a decision and forwards kind/candidates/policy', async () => {
  const server = await startServer((_request, response) => sendJson(response, 200, toolDecision));
  try {
    const client = clientFor(server);
    const result = await client.decideTool('fix the crash', candidates, { tau: 0.5 });
    assertSuccess(result);
    assert.deepEqual(result.chosen, ['skill:exec']);
    assert.equal(result.confidence, 0.91);
    assert.equal(result.noToolProb, 0.02);
    assert.equal(result.latencyMs, 420);
    assert.equal(result.modelVersion, 'biod-v0-final+abc');
    assert.deepEqual(result.scores, [
      { id: 'skill:exec', p: 0.91 },
      { id: 'mcp:fs', p: 0.09 },
    ]);

    const sent = JSON.parse(server.requests[0].body);
    assert.equal(server.requests[0].url, '/v1/decide');
    assert.equal(sent.kind, 'tool');
    assert.equal(sent.state, 'fix the crash');
    assert.deepEqual(sent.candidates, [
      { id: 'skill:exec', name: 'exec', description: 'run a command', kind: 'skill' },
      { id: 'mcp:fs', name: 'fs', description: 'read files', kind: 'mcp' },
    ]);
    assert.equal(sent.catalog.id, 'toollibrary');
    assert.equal(sent.catalog.total, 2);
    assert.equal(sent.catalog.shortlist, 2);
    assert.equal(sent.catalog.fingerprint.length, 64);
    assert.deepEqual(sent.policy, { tau: 0.5 });
    assert.equal(typeof sent.requestId, 'string');
  } finally {
    await server.close();
  }
});

test('decideKb maps a knowledge decision and sends topK', async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 200, {
      ok: true,
      decisionId: 'kb-1',
      kind: 'kb',
      modelVersion: 'biod-v0-final',
      candidateCount: 2,
      scores: [{ id: 'dbs/alpine', p: 0.77 }],
      chosen: ['dbs/alpine'],
      confidence: 0.77,
      latencyMs: 120,
      noToolProb: null,
    }),
  );
  try {
    const client = clientFor(server);
    const result = await client.decideKb('find a dataset', candidates, { tau: 0.5, topK: 3 });
    assertSuccess(result);
    assert.deepEqual(result.chosen, ['dbs/alpine']);
    assert.equal('noToolProb' in result, false);
    const sent = JSON.parse(server.requests[0].body);
    assert.equal(sent.kind, 'kb');
    assert.equal(sent.catalog.id, 'knowledgebase');
    assert.deepEqual(sent.policy, { tau: 0.5, topK: 3 });
  } finally {
    await server.close();
  }
});

test('scoreGroups caps the batch and maps scores', async () => {
  const groups = Array.from({ length: 40 }, (_value, index) => ({
    id: String(index),
    name: `tool:${index}`,
    description: 'x'.repeat(500),
  }));
  const server = await startServer((_request, response) =>
    sendJson(response, 200, { ok: true, scores: [{ id: '3', score: 0.73 }], latencyMs: 300 }),
  );
  try {
    const client = clientFor(server);
    const result = await client.scoreGroups('task text', groups);
    assertSuccess(result);
    assert.deepEqual(result.scores, [{ id: '3', score: 0.73 }]);
    assert.equal(result.latencyMs, 300);
    const sent = JSON.parse(server.requests[0].body);
    assert.equal(sent.groups.length, 32);
    assert.equal(sent.groups[0].description.length, 400);
    assert.equal(sent.state, 'task text');
  } finally {
    await server.close();
  }
});

test('an empty group batch is answered locally', async () => {
  const server = await startServer((_request, response) => sendJson(response, 200, { ok: true, scores: [] }));
  try {
    const client = clientFor(server);
    assert.deepEqual(await client.scoreGroups('task', []), { ok: true, scores: [], latencyMs: 0 });
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('a sidecar transport echo is preferred over the local estimate', async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 200, {
      ...toolDecision,
      transport: {
        mode: 'descriptions',
        candidateCount: 2,
        descriptionChars: 21,
        truncated: false,
        catalogFingerprint: 'echoed-fingerprint',
        catalogTotal: 2,
        shortlist: 2,
      },
    }),
  );
  try {
    const result = await clientFor(server).decideTool('fix the crash', candidates, { tau: 0.5 });
    assertSuccess(result);
    assert.equal(result.transport?.descriptionChars, 21);
    assert.equal(result.transport?.catalogFingerprint, 'echoed-fingerprint');
    assert.equal(result.transport?.mode, 'descriptions');
  } finally {
    await server.close();
  }
});

test('ids mode sends only ids for an older sidecar', async () => {
  const server = await startServer((_request, response) => sendJson(response, 200, toolDecision));
  try {
    const result = await clientFor(server).decideTool(
      'fix the crash', candidates, { tau: 0.5 }, undefined, undefined, { candidates: 'ids' },
    );
    assertSuccess(result);
    assert.equal(result.transport?.mode, 'ids');
    const sent = JSON.parse(server.requests[0].body);
    assert.deepEqual(sent.candidates, ['skill:exec', 'mcp:fs']);
    assert.equal(sent.catalog.descriptionChars, 0);
  } finally {
    await server.close();
  }
});

test('5xx is bad_response', async () => {
  const server = await startServer((_request, response) => sendJson(response, 500, { ok: false, error: { code: 'INTERNAL', message: 'boom' } }));
  try {
    const result = await clientFor(server).decideTool('state', candidates, { tau: 0.5 });
    assertFailure(result);
    assert.equal(result.reason, 'bad_response');
  } finally {
    await server.close();
  }
});

test('prompt-too-long does not open the health circuit', async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 413, { error: { code: 'PROMPT_TOO_LONG', message: 'prompt exceeds max_len' } }),
  );
  try {
    const client = clientFor(server);
    for (let index = 0; index < 6; index += 1) {
      const result = await client.decideTool('state', candidates, { tau: 0.5 });
      assertFailure(result);
      assert.equal(result.reason, 'prompt_too_long');
    }
    assert.equal(server.requests.length, 6);
  } finally {
    await server.close();
  }
});

test('invalid JSON is bad_response', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('<html>proxy error</html>');
  });
  try {
    const result = await clientFor(server).decideTool('state', candidates, { tau: 0.5 });
    assertFailure(result);
    assert.equal(result.reason, 'bad_response');
  } finally {
    await server.close();
  }
});

test('HTTP 400 CKPT_MISMATCH is catalog_mismatch', async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 400, { ok: false, error: { code: 'CKPT_MISMATCH', message: 'unknown candidate id' } }),
  );
  try {
    const result = await clientFor(server).decideTool('state', candidates, { tau: 0.5 });
    assertFailure(result);
    assert.equal(result.reason, 'catalog_mismatch');
    assert.match(result.message ?? '', /unknown candidate id/);
  } finally {
    await server.close();
  }
});

test('HTTP 413 PROMPT_TOO_LONG stays observable for the browse fallback', async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 413, { error: { code: 'PROMPT_TOO_LONG', message: 'prompt exceeds max_len' } }),
  );
  try {
    const result = await clientFor(server).decideTool('state', candidates, { tau: 0.5 });
    assertFailure(result);
    assert.equal(result.reason, 'prompt_too_long');
    assert.match(result.message ?? '', /prompt exceeds max_len/);
  } finally {
    await server.close();
  }
});

test('HTTP 503 MODEL_NOT_READY is not_ready', async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 503, { ok: false, error: { code: 'MODEL_NOT_READY', message: 'loading' } }),
  );
  try {
    const result = await clientFor(server).decideTool('state', candidates, { tau: 0.5 });
    assertFailure(result);
    assert.equal(result.reason, 'not_ready');
  } finally {
    await server.close();
  }
});

test('a slow server yields timeout and never throws', async () => {
  const server = await startServer((_request, response) => {
    setTimeout(() => sendJson(response, 200, toolDecision), 300);
  });
  try {
    const client = clientFor(server, { requestTimeoutMs: 60 });
    const startedAt = Date.now();
    const result = await client.decideTool('state', candidates, { tau: 0.5 });
    assertFailure(result);
    assert.equal(result.reason, 'timeout');
    assert.ok(Date.now() - startedAt < 250, 'the client must give up at its own timeout');
  } finally {
    await server.close();
  }
});

test('a refused connection is network', async () => {
  const dead = await startServer((_request, response) => sendJson(response, 200, { ok: true }));
  const baseUrl = dead.baseUrl;
  await dead.close();
  const client = new HttpBiodClient({ baseUrl, requestTimeoutMs: 500, contextTimeoutMs: 500 });
  assert.equal((await client.health(500)).ok, false);
  const result = await client.decideTool('state', candidates, { tau: 0.5 });
  assertFailure(result);
  assert.equal(result.reason, 'network');
});

test('five consecutive failures open the circuit for the configured window', async () => {
  let failing = true;
  const server = await startServer((_request, response) => {
    if (failing) {
      sendJson(response, 500, { ok: false, error: { code: 'INTERNAL', message: 'boom' } });
      return;
    }
    sendJson(response, 200, toolDecision);
  });
  try {
    const client = clientFor(server, { circuitOpenMs: 40 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await client.decideTool('state', candidates, { tau: 0.5 });
      assertFailure(result);
      assert.equal(result.reason, 'bad_response');
    }
    const open = await client.decideTool('state', candidates, { tau: 0.5 });
    assertFailure(open);
    assert.equal(open.reason, 'circuit_open');
    assert.equal(server.requests.length, 5, 'an open circuit must not touch the socket');

    // The window is short in this test; once it expires the next call is real again.
    failing = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const recovered = await client.decideTool('state', candidates, { tau: 0.5 });
    assertSuccess(recovered);
  } finally {
    await server.close();
  }
});

test('a malformed decision payload is bad_response', async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 200, { ok: true, decisionId: 'x', chosen: 'not-an-array', scores: [], confidence: 0.5 }),
  );
  try {
    const result = await clientFor(server).decideTool('state', candidates, { tau: 0.5 });
    assertFailure(result);
    assert.equal(result.reason, 'bad_response');
  } finally {
    await server.close();
  }
});

test('an empty candidate list is rejected locally as catalog_mismatch', async () => {
  const server = await startServer((_request, response) => sendJson(response, 200, toolDecision));
  try {
    const result = await clientFor(server).decideTool('state', [], { tau: 0.5 });
    assertFailure(result);
    assert.equal(result.reason, 'catalog_mismatch');
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});
