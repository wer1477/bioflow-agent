import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBiodConfig, type BiodConfig } from '../src/agent/biod/config.js';
import { budgetFor } from '../src/agent/biod/framework/budget.js';
import { HttpScorer } from '../src/agent/biod/framework/scorers.js';
import { NO_TOOL_ID, type PlanStep, type PlanToolCandidate } from '../src/agent/biod/researcher/contracts.js';
import { HttpPlanAuditScorer, createPlanAuditScorer } from '../src/agent/biod/researcher/scorers.js';
import { HttpIssueTriageScorer, createIssueTriageScorer } from '../src/agent/biod/reviewer/scorers.js';
import type {
  ClaimEvidenceRow,
  ParsedClaim,
} from '../src/agent/biod/writer/contracts.js';
import { HttpManuscriptAuditScorer, createManuscriptAuditScorer } from '../src/agent/biod/writer/scorers.js';
import { BiodService } from '../src/agent/biod/service.js';
import type { DecisionRequest, SearcherArtifacts } from '../src/agent/biod/framework/contracts.js';

/* ------------------------------------------------------------------ */
/* A local sidecar double: records every request and lets each test    */
/* decide how each endpoint answers (200 / 500 / hang).                */
/* ------------------------------------------------------------------ */

interface RecordedRequest {
  path: string;
  body: Record<string, unknown>;
}

type Handler = (request: RecordedRequest, response: http.ServerResponse) => void;

interface TestServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const recorded = { path: request.url ?? '', body };
      requests.push(recorded);
      handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function pairResponse(items: unknown[], modelVersion = 'biod-mt-v2', latencyMs = 37): unknown {
  return { ok: true, task: 'premise_judge', items, modelVersion, latencyMs };
}

/** The `s2.premise.short-v1` rendering (see framework/renderers.ts). */
const PREMISE_STATE = '[S|P] C:X increase P:X is increased after treatment E:X increased after treatment X:human/liver/up';

const PREMISE_LABELS = [
  { id: 'supported', name: 'supported' },
  { id: 'contradicted', name: 'contradicted' },
  { id: 'unknown', name: 'unknown' },
];

function premiseSignalInput() {
  return {
    decisionPoint: 's2.premise' as const,
    state: PREMISE_STATE,
    candidates: PREMISE_LABELS,
    labels: PREMISE_LABELS,
    budget: budgetFor('short'),
  };
}

function closeEnough(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} != ${expected}`);
}

/* ------------------------------------------------------------------ */
/* S2 premise (framework HttpScorer)                                   */
/* ------------------------------------------------------------------ */

test('HttpScorer posts one premise_judge item and maps five H6 classes onto the three S2 labels', async () => {
  const server = await startServer((_request, response) => {
    json(response, 200, pairResponse([{
      id: 's2.premise',
      label: 'supports',
      confidence: 0.91,
      // Deliberately unnormalized: the adapter must normalize, not trust the wire sum.
      probs: { supports: 6, partially_supports: 2, contradicts: 1, unrelated: 0.5, insufficient: 0.5 },
    }]));
  });
  try {
    const scorer = new HttpScorer({ baseUrl: server.baseUrl, timeoutMs: 500 });
    const signal = await scorer.score(premiseSignalInput());

    assert.equal(server.requests[0]?.path, '/v1/score-pairs');
    const body = server.requests[0]?.body as {
      task: string;
      items: Array<Record<string, string>>;
    };
    assert.equal(body.task, 'premise_judge');
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, 's2.premise');
    assert.equal(body.items[0].unit, 'hypothesis');
    assert.match(body.items[0].left, /X is increased after treatment/);
    assert.match(body.items[0].left, /X increase/);
    assert.equal(body.items[0].right, 'X increased after treatment');
    assert.equal(body.items[0].context, 'human/liver/up');

    assert.equal(signal.kind, 'choice');
    assert.equal(signal.abstain, false);
    assert.equal(signal.choice, 'supported');
    closeEnough(signal.scores.supported, 0.8);
    closeEnough(signal.scores.contradicted, 0.1);
    closeEnough(signal.scores.unknown, 0.1);
    closeEnough(signal.scores.supported + signal.scores.contradicted + signal.scores.unknown, 1);
    assert.equal(signal.confidence, 0.91);
    assert.equal(signal.modelVersion, 'biod-mt-v2');
    assert.equal(signal.latencyMs, 37);
  } finally {
    await server.close();
  }
});

test('HttpScorer abstains without throwing on a 500 response', async () => {
  const server = await startServer((_request, response) => {
    json(response, 500, { ok: false, error: 'boom' });
  });
  try {
    const scorer = new HttpScorer({ baseUrl: server.baseUrl, timeoutMs: 500 });
    const signal = await scorer.score(premiseSignalInput());
    assert.equal(signal.abstain, true);
    assert.equal(signal.kind, 'choice');
    assert.deepEqual(signal.scores, {});
    assert.ok(signal.reasons.includes('http_500'));
  } finally {
    await server.close();
  }
});

test('HttpScorer abstains without throwing when the sidecar hangs past the timeout', async () => {
  const server = await startServer(() => {
    // Deliberately never respond.
  });
  try {
    const scorer = new HttpScorer({ baseUrl: server.baseUrl, timeoutMs: 60 });
    const started = Date.now();
    const signal = await scorer.score(premiseSignalInput());
    assert.equal(signal.abstain, true);
    assert.ok(signal.reasons.includes('timeout'), `reasons=${signal.reasons.join(',')}`);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* Writer W1                                                           */
/* ------------------------------------------------------------------ */

function claim(): ParsedClaim {
  return {
    claimId: 'C1',
    section: 'results',
    claimText: 'X causally increases Y',
    claimType: 'causal',
    writerStatus: 'supported',
    rows: [],
    placements: ['results'],
    stale: false,
    sectionMismatch: false,
  };
}

function evidence(): ClaimEvidenceRow {
  return {
    claimId: 'C1',
    section: 'results',
    claimText: 'X causally increases Y',
    claimType: 'causal',
    evidenceId: 'E1',
    evidenceType: 'citation',
    evidenceLocator: 'Fig 1A',
    evidenceQuote: 'X increased Y in mice',
    evidenceScope: 'mouse cohort',
    writerRelation: 'supports',
    writerStatus: 'supported',
    notes: '',
  };
}

test('HttpManuscriptAuditScorer makes one call per task and merges relation + overclaim flags', async () => {
  const server = await startServer((request, response) => {
    const task = request.body.task;
    if (task === 'premise_judge') {
      json(response, 200, pairResponse([{
        id: 'C1:E1',
        label: 'partially_supports',
        confidence: 0.77,
        probs: { supports: 0.4, partially_supports: 0.3, contradicts: 0.1, unrelated: 0.1, insufficient: 0.1 },
      }]));
      return;
    }
    if (task === 'overclaim_flag') {
      json(response, 200, {
        ok: true,
        task: 'overclaim_flag',
        items: [{ id: 'C1:E1', label: null, flags: ['scope', 'mystery', 'causality'], confidence: 0.66, probs: {} }],
        modelVersion: 'biod-mt-v2',
        latencyMs: 11,
      });
      return;
    }
    json(response, 400, { ok: false, error: 'unexpected task' });
  });
  try {
    const scorer = new HttpManuscriptAuditScorer({ baseUrl: server.baseUrl, timeoutMs: 500 });
    const signal = await scorer.score({ claim: claim(), evidence: evidence() });

    assert.deepEqual(server.requests.map((request) => request.body.task).sort(), ['overclaim_flag', 'premise_judge']);
    for (const request of server.requests) {
      const items = request.body.items as Array<Record<string, string>>;
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'C1:E1');
      assert.equal(items[0].unit, 'claim');
      assert.equal(items[0].left, 'X causally increases Y');
      assert.equal(items[0].right, 'X increased Y in mice');
      assert.equal(items[0].context, 'mouse cohort');
    }

    closeEnough(signal.scores.supports, 0.4);
    closeEnough(signal.scores.partially_supports, 0.3);
    closeEnough(signal.scores.contradicts, 0.1);
    closeEnough(signal.scores.unrelated, 0.1);
    closeEnough(signal.scores.unverifiable, 0.1);
    closeEnough(Object.values(signal.scores).reduce((sum, value) => sum + value, 0), 1);
    assert.deepEqual(signal.overclaim, ['scope', 'causality']);
    assert.equal(signal.confidence, 0.77);
    assert.equal(signal.abstain, false);
  } finally {
    await server.close();
  }
});

test('HttpManuscriptAuditScorer abstains only when both calls fail', async () => {
  const server = await startServer((_request, response) => {
    json(response, 500, { ok: false, error: 'down' });
  });
  try {
    const scorer = new HttpManuscriptAuditScorer({ baseUrl: server.baseUrl, timeoutMs: 500 });
    const signal = await scorer.score({ claim: claim(), evidence: evidence() });
    assert.equal(signal.abstain, true);
    assert.deepEqual(signal.overclaim, []);
    closeEnough(signal.scores.unverifiable, 1);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* Researcher R1                                                       */
/* ------------------------------------------------------------------ */

function planStep(): PlanStep {
  return {
    id: 'S1',
    goal: 'Quantify X in treated samples',
    inputs: ['count matrices'],
    outputs: ['differential table'],
    constraints: ['no GPU'],
  };
}

function toolCandidates(): PlanToolCandidate[] {
  return [
    { id: 'tool-a', name: 'scanpy', kind: 'skill', description: 'single-cell analysis', isCurrent: false },
    { id: 'tool-b', name: 'deseq2', kind: 'skill', description: 'bulk differential expression', isCurrent: false },
    { id: NO_TOOL_ID, name: NO_TOOL_ID, kind: 'pseudo', description: 'keep manual work', isCurrent: false },
  ];
}

test('HttpPlanAuditScorer sends the rendered step and maps decide scores + noToolProb', async () => {
  const server = await startServer((_request, response) => {
    json(response, 200, {
      chosen: ['tool-a'],
      scores: [{ id: 'tool-a', p: 0.7 }, { id: 'tool-b', p: 0.2 }],
      confidence: 0.7,
      noToolProb: 0.1,
      modelVersion: 'biod-mt-v2',
      latencyMs: 23,
    });
  });
  try {
    const scorer = new HttpPlanAuditScorer({ baseUrl: server.baseUrl, timeoutMs: 500 });
    const signal = await scorer.score({
      step: planStep(),
      state: '',
      candidates: toolCandidates(),
      budget: budgetFor('audit'),
    });

    assert.equal(server.requests[0]?.path, '/v1/decide');
    const body = server.requests[0]?.body as {
      kind: string;
      role: string;
      state: string;
      candidates: Array<{ id: string }>;
    };
    assert.equal(body.kind, 'tool');
    assert.equal(body.role, 'researcher');
    assert.match(body.state, /Step: Quantify X in treated samples/);
    assert.match(body.state, /Inputs: count matrices/);
    assert.match(body.state, /Outputs: differential table/);
    assert.match(body.state, /Constraints: no GPU/);
    // NO_TOOL is the policy's abstain vote, not a tool id the head can score.
    assert.deepEqual(body.candidates, [{ id: 'tool-a' }, { id: 'tool-b' }]);

    assert.equal(signal.abstain, false);
    closeEnough(signal.scores['tool-a'], 0.7);
    closeEnough(signal.scores['tool-b'], 0.2);
    closeEnough(signal.scores[NO_TOOL_ID], 0.1);
    assert.equal(signal.confidence, 0.7);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* Reviewer V1                                                         */
/* ------------------------------------------------------------------ */

function parsedIssue() {
  return {
    issueId: 'I1',
    section: 'methods' as const,
    issueText: 'The primary model is not adjusted for confounders.',
    issueType: 'statistical' as const,
    severityClaim: 'blocking' as const,
    premises: [{
      issueId: 'I1',
      section: 'methods' as const,
      issueText: 'The primary model is not adjusted for confounders.',
      issueType: 'statistical' as const,
      severityClaim: 'blocking' as const,
      premiseId: 'P1',
      premiseKind: 'passage' as const,
      premiseText: 'The primary model is described as unadjusted.',
      anchorLocator: 'Methods ¶1',
      anchorQuote: 'We fitted an unadjusted model.',
      anchorQuote2: '',
      searchTerms: [],
      notes: 'Adjust for age and sex.',
    }],
    duplicates: [],
  };
}

test('HttpIssueTriageScorer maps premise relations and owner role scores', async () => {
  const server = await startServer((request, response) => {
    if (request.path === '/v1/score-pairs') {
      json(response, 200, pairResponse([{
        id: 'I1:P1',
        label: 'partially_supports',
        confidence: 0.82,
        probs: { supports: 0.5, partially_supports: 0.2, contradicts: 0.1, unrelated: 0.1, insufficient: 0.1 },
      }]));
      return;
    }
    if (request.path === '/v1/decide/role_select') {
      json(response, 200, {
        role: 'writer',
        confidence: 0.8,
        scores: [
          { role: 'writer', p: 0.8 },
          { role: 'researcher', p: 0.1 },
          { role: 'pi', p: 0.1 },
          { role: 'not-a-role', p: 0.4 },
        ],
      });
      return;
    }
    json(response, 404, { ok: false, error: 'not found' });
  });
  try {
    const scorer = new HttpIssueTriageScorer({ baseUrl: server.baseUrl, timeoutMs: 500 });
    const issue = parsedIssue();

    const premise = await scorer.scorePremise({
      issue,
      premise: issue.premises[0],
      passage: 'We fitted an adjusted multivariable Cox model.',
      passage2: 'A second unadjusted model was also reported.',
    });
    const pairBody = server.requests[0]?.body as {
      task: string;
      items: Array<Record<string, string>>;
    };
    assert.equal(pairBody.task, 'premise_judge');
    assert.equal(pairBody.items[0].unit, 'issue');
    assert.equal(pairBody.items[0].left, 'The primary model is described as unadjusted.');
    assert.match(pairBody.items[0].right, /adjusted multivariable Cox model/);
    assert.match(pairBody.items[0].right, /second unadjusted model/);
    assert.match(pairBody.items[0].context, /issue_type=statistical/);
    closeEnough(premise.scores.holds, 0.7);
    closeEnough(premise.scores.contradicted, 0.1);
    closeEnough(premise.scores.unresolved, 0.2);
    assert.equal(premise.confidence, 0.82);
    assert.equal(premise.abstain, false);

    const owner = await scorer.scoreOwner({ issue, premiseStatus: 'premises_hold' });
    const ownerBody = server.requests[1]?.body as { state: string };
    assert.match(ownerBody.state, /Issue: The primary model is not adjusted for confounders\./);
    assert.match(ownerBody.state, /Premise: The primary model is described as unadjusted\./);
    assert.match(ownerBody.state, /Expected fix: Adjust for age and sex\./);
    closeEnough(owner.scores.writer, 0.8);
    closeEnough(owner.scores.researcher, 0.1);
    closeEnough(owner.scores.pi, 0.1);
    closeEnough(owner.scores.searcher, 0);
    assert.equal(owner.confidence, 0.8);
    assert.equal(owner.abstain, false);

    const before = server.requests.length;
    const pair = await scorer.scorePair({ a: issue, b: issue, title: 'Paper' });
    assert.equal(server.requests.length, before, 'scorePair must not call the model');
    assert.equal(pair.abstain, true);
    assert.deepEqual(pair.reasons, ['model_unavailable']);
    assert.deepEqual(pair.scores, { a: 0, b: 0, tie: 1 });
  } finally {
    await server.close();
  }
});

test('HttpIssueTriageScorer fails open on premise and owner errors', async () => {
  const server = await startServer((_request, response) => {
    json(response, 500, { ok: false, error: 'down' });
  });
  try {
    const scorer = new HttpIssueTriageScorer({ baseUrl: server.baseUrl, timeoutMs: 500 });
    const issue = parsedIssue();
    const premise = await scorer.scorePremise({ issue, premise: issue.premises[0], passage: 'A passage long enough to be judged.' });
    assert.equal(premise.abstain, true);
    closeEnough(premise.scores.unresolved, 1);
    const owner = await scorer.scoreOwner({ issue, premiseStatus: 'premise_unresolved' });
    assert.equal(owner.abstain, true);
    closeEnough(owner.scores.pi, 1);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

test('the HTTP scorer factories throw when no base URL is configured', () => {
  assert.throws(() => createManuscriptAuditScorer('http'), /base\s*url/i);
  assert.throws(() => createPlanAuditScorer('http'), /base\s*url/i);
  assert.throws(() => createIssueTriageScorer('http'), /base\s*url/i);
  assert.throws(() => new HttpScorer({ baseUrl: '   ' }), /base\s*url/i);
  assert.throws(() => new HttpManuscriptAuditScorer({ baseUrl: '' }), /base\s*url/i);
  assert.throws(() => new HttpPlanAuditScorer({ baseUrl: '' }), /base\s*url/i);
  assert.throws(() => new HttpIssueTriageScorer({ baseUrl: '' }), /base\s*url/i);
});

test('the HTTP scorer factories construct the real scorer when a base URL exists', () => {
  const baseUrl = 'http://127.0.0.1:8790';
  assert.ok(createManuscriptAuditScorer('http', { baseUrl }) instanceof HttpManuscriptAuditScorer);
  assert.ok(createPlanAuditScorer('http', undefined, { baseUrl }) instanceof HttpPlanAuditScorer);
  assert.ok(createIssueTriageScorer('http', { baseUrl }) instanceof HttpIssueTriageScorer);
});

/* ------------------------------------------------------------------ */
/* Service wiring: config selects the HTTP scorer                      */
/* ------------------------------------------------------------------ */

function testConfig(overrides: { premiseScorer?: string; pairTimeoutMs?: number } = {}): BiodConfig {
  return {
    enabled: true,
    service: {
      baseUrl: 'http://127.0.0.1:8790',
      autoStart: false,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 500,
      contextTimeoutMs: 500,
      pairTimeoutMs: overrides.pairTimeoutMs ?? 500,
    },
    runtime: { device: 'cpu', dtype: 'float32' },
    model: { expectedVersion: 'biod-mt-v2' },
    decisionPoints: {
      tool_select: { mode: 'off', tau: 0.5 },
      kb_select: { mode: 'off', tau: 0.5, topK: 3 },
      context_retention: { mode: 'off', maxGroups: 32 },
      role_select: { mode: 'off', tau: 0.6 },
      relay_select: { mode: 'off', floor: 0.75 },
    },
    framework: {
      enabled: true,
      defaultMode: 'off',
      decisionPoints: {
        's2.premise': { mode: 'assist', scorer: overrides.premiseScorer ?? 'http', budget: 'short' },
        's2.rerank': { mode: 'assist', scorer: 'heuristic', budget: 'long' },
        's2.policy': { mode: 'assist', budget: 'rule' },
        's3.trigger': { mode: 'off', budget: 'rule' },
        's5.diversity': { mode: 'off', budget: 'rule' },
      },
    },
    state: { maxChars: 220 },
    warnings: [],
  };
}

function searcherArtifacts(): SearcherArtifacts {
  return {
    hypotheses: [{
      id: 'H1',
      gapIds: ['G1'],
      claim: 'X increases Y in treated samples',
      premises: [{ pid: 'p1', text: 'X is increased after treatment', type: 'empirical' }],
      predictions: [{ text: 'Y rises after X activation', readout: 'qPCR', direction: 'up', falsifier: 'no change' }],
      evidenceLinks: [{ eid: 'E1', relation: 'supports' }],
      alternatives: ['Reverse causation'],
    }],
    evidence: [{ id: 'E1', locator: 'Fig 1A', snippet: 'X increased after treatment' }],
  };
}

function premiseRequest(): DecisionRequest {
  return {
    requestId: 'req-s2',
    runId: 'run-s2',
    role: 'searcher',
    decisionPoint: 's2.premise',
    mode: 'assist',
    artifacts: searcherArtifacts(),
    focus: { hypId: 'H1', pid: 'p1', evidenceId: 'E1' },
    budget: budgetFor('short'),
    context: { sessionId: 's', rolePromptVersion: 'searcher', rendererVersion: 'test' },
  };
}

test('service honours scorer:"http" from biod.json for s2.premise', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-http-'));
  const server = await startServer((_request, response) => {
    json(response, 200, pairResponse([{
      id: 's2.premise',
      label: 'supports',
      confidence: 0.9,
      probs: { supports: 0.6, partially_supports: 0.2, contradicts: 0.1, unrelated: 0.05, insufficient: 0.05 },
    }]));
  });
  try {
    const config = testConfig({ premiseScorer: 'http' });
    config.service.baseUrl = server.baseUrl;
    const service = new BiodService({
      config,
      decisionsFile: path.join(directory, 'decisions.jsonl'),
      environment: {},
    });

    const decision = await service.runDecision(premiseRequest());
    assert.equal(decision.action, 'select');
    assert.deepEqual(decision.selected, ['supported']);
    assert.equal(decision.fallback, false);
    assert.equal(server.requests.length, 1);

    const ledgerPath = path.join(directory, 'biod-framework-decisions.jsonl');
    const record = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').trim()) as {
      modelVersion: string;
      scores: Record<string, number>;
    };
    assert.equal(record.modelVersion, 'biod-mt-v2');
    closeEnough(record.scores.supported, 0.8);
    closeEnough(record.scores.contradicted, 0.1);
    closeEnough(record.scores.unknown, 0.1);
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('service keeps the heuristic scorer for an unknown scorer value and records a config warning', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-http-'));
  try {
    const config = testConfig({ premiseScorer: 'quantum' });
    const service = new BiodService({
      config,
      decisionsFile: path.join(directory, 'decisions.jsonl'),
      environment: {},
    });

    const decision = await service.runDecision(premiseRequest());
    assert.equal(decision.fallback, false);
    assert.ok(config.warnings.some((warning) => warning.includes('"quantum"')), config.warnings.join('\n'));

    const ledgerPath = path.join(directory, 'biod-framework-decisions.jsonl');
    const record = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').trim()) as { modelVersion: string };
    assert.equal(record.modelVersion, 'heuristic-v1');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the shipped biod.json preserves the legacy pair timeout without enabling audit checkpoints', () => {
  const configDirectory = fileURLToPath(new URL('../config', import.meta.url));
  const parsed = loadBiodConfig(configDirectory, {});
  assert.equal(parsed.service.pairTimeoutMs, 8000);
  assert.equal(parsed.framework?.enabled, false);
});
