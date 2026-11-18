import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetFor } from '../src/agent/biod/framework/budget.js';
import { BiodFramework, JsonlDecisionLedger } from '../src/agent/biod/framework/orchestrator.js';
import { MockScorer } from '../src/agent/biod/framework/scorers.js';
import { BiodService } from '../src/agent/biod/service.js';
import { screenSearcher } from '../src/agent/biod/framework/screen.js';
import type {
  DecisionPointId,
  DecisionRequest,
  DecisionRecord,
  HypothesisCard,
  Scorer,
} from '../src/agent/biod/framework/index.js';
import { estimateTokens } from '../src/agent/biod/framework/budget.js';
import { S2PremiseRenderer } from '../src/agent/biod/framework/renderers.js';

const CARD_A: HypothesisCard = {
  id: 'H1',
  gapIds: ['G1'],
  claim: 'Knocking down Y reduces Z phosphorylation',
  mechanism: 'Y is an upstream kinase of Z',
  premises: [{ pid: 'p1', text: 'Y is an upstream kinase of Z', type: 'mechanistic' }],
  predictions: [{ text: 'p-Z decreases', readout: 'WB', direction: 'decrease', falsifier: 'no change' }],
  evidenceLinks: [{ eid: 'E1', relation: 'supports' }],
  alternatives: ['technical artifact'],
  dataNeeded: 'HeLa lysate',
  feasibility: { assay: 'WB', sample: 'HeLa', time: '1 week', costTier: 'low' },
  risks: ['antibody specificity'],
};

const CARD_B: HypothesisCard = {
  ...CARD_A,
  id: 'H2',
  claim: 'Knocking down Y increases Z phosphorylation',
  evidenceLinks: [{ eid: 'E2', relation: 'conflicts' }],
  premises: [{ pid: 'p1', text: 'Y is an upstream kinase of Z', type: 'mechanistic' }],
};

const EVIDENCE = [
  { id: 'E1', locator: 'PMID:1', snippet: 'Y knockdown reduced p-Z by 60% in HeLa', context: { species: 'human', system: 'HeLa', direction: 'decrease' } },
  { id: 'E2', locator: 'PMID:2', snippet: 'Y knockdown increased p-Z in HeLa', context: { species: 'human', system: 'HeLa', direction: 'increase' } },
];

function request(decisionPoint: DecisionPointId, extra: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: `req-${decisionPoint}`,
    runId: 'run-1',
    role: 'searcher',
    decisionPoint,
    mode: 'shadow',
    artifacts: { rq: 'Does Y regulate Z?', reviewSummary: 'Mixed evidence in HeLa.', gaps: ['G1'], hypotheses: [CARD_A, CARD_B], evidence: EVIDENCE },
    budget: budgetFor('short'),
    context: { sessionId: 's1', rolePromptVersion: 'searcher-v3', rendererVersion: 'test' },
    ...extra,
  };
}

function memoryLedger(): { records: DecisionRecord[]; append(record: DecisionRecord): void } {
  const records: DecisionRecord[] = [];
  return { records, append(record) { records.push(record); } };
}

test('premise renderer keeps the short state within budget and includes premise/evidence', () => {
  const renderer = new S2PremiseRenderer();
  const budget = budgetFor('short');
  const rendered = renderer.render(request('s2.premise', {
    focus: { hypId: 'H1', pid: 'p1', evidenceId: 'E1' },
  }), budget);
  assert.match(rendered.state, /P:Y is an upstream kinase of Z/);
  assert.match(rendered.state, /E:Y knockdown reduced p-Z/);
  assert.ok(estimateTokens(rendered.state) <= budget.maxStateTokens);
  assert.equal(rendered.truncated, false);
});

test('framework runs s2.premise, returns a label and appends a ledger record', async () => {
  const ledger = memoryLedger();
  const framework = new BiodFramework({ scorers: { 's2.premise': new MockScorer('choice') }, ledger });
  const decision = await framework.runDecision(request('s2.premise', {
    focus: { hypId: 'H1', pid: 'p1', evidenceId: 'E1' },
  }));
  assert.equal(decision.fallback, false);
  assert.equal(decision.action, 'select');
  assert.ok(decision.selected?.length === 1);
  assert.ok(['supported', 'contradicted', 'unknown'].includes(decision.selected![0]));
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].decisionPoint, 's2.premise');
  assert.equal(ledger.records[0].role, 'searcher');
});

test('framework runs s2.rerank over K cards and returns a full ranking', async () => {
  const ledger = memoryLedger();
  const framework = new BiodFramework({ scorers: { 's2.rerank': new MockScorer('rerank') }, ledger });
  const cards = ['H1', 'H2', 'H3', 'H4'].map((id) => ({ ...CARD_A, id, claim: `${id}: knocking down Y reduces Z` }));
  const decision = await framework.runDecision(request('s2.rerank', {
    budget: budgetFor('long'),
    artifacts: { rq: 'Does Y regulate Z?', reviewSummary: 'Mixed evidence.', gaps: ['G1'], hypotheses: cards, evidence: EVIDENCE },
  }));
  assert.equal(decision.fallback, false);
  assert.deepEqual(new Set(decision.ranked), new Set(['H1', 'H2', 'H3', 'H4']));
  assert.equal(ledger.records[0].decisionPoint, 's2.rerank');
  assert.ok(ledger.records[0].truncated === false);
});

test('s2.policy defers a contradicted premise and keeps a shortlist', async () => {
  const ledger = memoryLedger();
  const framework = new BiodFramework({ ledger });
  const decision = await framework.runDecision(request('s2.policy', {
    budget: budgetFor('rule'),
    artifacts: {
      rq: 'Does Y regulate Z?',
      reviewSummary: 'Mixed evidence.',
      gaps: ['G1'],
      hypotheses: [CARD_A, CARD_B],
      evidence: EVIDENCE,
      premiseVerdicts: [
        { hypId: 'H1', pid: 'p1', verdict: 'supported', confidence: 0.9, evidenceId: 'E1' },
        { hypId: 'H2', pid: 'p1', verdict: 'contradicted', confidence: 0.9, evidenceId: 'E2' },
      ],
      rerankScores: { H1: 0.9, H2: 0.4 },
    },
  }));
  assert.equal(decision.fallback, false);
  assert.deepEqual(decision.selected, ['H1']);
  assert.ok(decision.deferred?.some((entry) => entry.id === 'H2' && entry.reason.includes('E2')));
});

test('s3.trigger and s5.diversity are rule-based decisions', async () => {
  const framework = new BiodFramework();
  const trigger = await framework.runDecision(request('s3.trigger', {
    artifacts: {
      rq: 'q',
      hypotheses: [CARD_A],
      evidence: EVIDENCE,
      premiseVerdicts: [{ hypId: 'H1', pid: 'p1', verdict: 'unknown', confidence: 0.2, evidenceId: 'E1' }],
    },
  }));
  assert.equal(trigger.action, 'trigger');
  assert.deepEqual(trigger.selected, ['H1']);

  const diversity = await framework.runDecision(request('s5.diversity', { budget: budgetFor('rule') }));
  assert.equal(diversity.action, 'guard');
  assert.ok(diversity.selected?.length);
});

test('framework fails open on invalid artifacts, low candidates and scorer exceptions', async () => {
  const invalid = new BiodFramework();
  const invalidDecision = await invalid.runDecision(request('s2.premise', { artifacts: { hypotheses: [], evidence: [] } }));
  assert.equal(invalidDecision.fallback, true);
  assert.equal(invalidDecision.action, 'abstain');

  const low = new BiodFramework();
  const lowDecision = await low.runDecision(request('s2.premise', {
    artifacts: { hypotheses: [CARD_A], evidence: EVIDENCE },
    candidates: [],
    focus: { hypId: 'H1', pid: 'p1', evidenceId: 'E1' },
  }));
  assert.equal(lowDecision.fallback, true);

  const throwing: Scorer = {
    kind: 'choice',
    modelVersion: 'throwing-v1',
    supports() { return true; },
    async score() { throw new Error('boom'); },
  };
  const broken = new BiodFramework({ scorers: { 's2.premise': throwing } });
  const brokenDecision = await broken.runDecision(request('s2.premise', {
    focus: { hypId: 'H1', pid: 'p1', evidenceId: 'E1' },
  }));
  assert.equal(brokenDecision.fallback, true);
});

test('jsonl ledger is a no-op when no file is configured', () => {
  const ledger = new JsonlDecisionLedger('');
  assert.doesNotThrow(() => ledger.append({} as DecisionRecord));
});

test('BiodService.runDecision delegates to an injected framework', async () => {
  const ledger = memoryLedger();
  const framework = new BiodFramework({ scorers: { 's2.premise': new MockScorer('choice') }, ledger });
  const service = new BiodService({ framework, environment: {} });
  const decision = await service.runDecision(request('s2.premise', {
    focus: { hypId: 'H1', pid: 'p1', evidenceId: 'E1' },
  }));
  assert.equal(decision.fallback, false);
  assert.equal(ledger.records.length, 1);
});

test('screenSearcher runs the full S2 pipeline and returns a shortlist', async () => {
  const cards = ['H1', 'H2', 'H3', 'H4'].map((id) => ({ ...CARD_A, id, claim: `${id}: knocking down Y reduces Z` }));
  const result = await screenSearcher(
    { rq: 'Does Y regulate Z?', reviewSummary: 'Mixed evidence.', gaps: ['G1'], hypotheses: cards, evidence: EVIDENCE },
    { mode: 'shadow', runId: 'run-screen', sessionId: 's1', rolePromptVersion: 'searcher-v3' },
  );
  assert.ok(result.decisions.length >= 4);
  assert.equal(result.premiseVerdicts.length, 4);
  assert.ok(result.shortlist.length > 0);
  assert.ok(result.ranked.length === 4);
});
