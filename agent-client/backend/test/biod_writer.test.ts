import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { budgetFor } from '../src/agent/biod/framework/budget.js';
import { loadBiodConfig, type BiodConfig } from '../src/agent/biod/config.js';
import { BiodService } from '../src/agent/biod/service.js';
import {
  DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS,
  DEFAULT_MANUSCRIPT_PRECHECK,
  type ClaimEvidenceRow,
  type EvidenceAudit,
  type ParsedClaim,
  type PrecheckResult,
} from '../src/agent/biod/writer/contracts.js';
import { parseBibTeX, orphanCitationKeys } from '../src/agent/biod/writer/index.js';
import { parseClaimMatrix } from '../src/agent/biod/writer/claim-matrix.js';
import { annotateClaims, parseManuscript } from '../src/agent/biod/writer/manuscript.js';
import { runPrecheck } from '../src/agent/biod/writer/precheck.js';
import { fitManuscriptAuditBudget, renderManuscriptAuditState } from '../src/agent/biod/writer/renderer.js';
import { HeuristicManuscriptAuditScorer, MockManuscriptAuditScorer } from '../src/agent/biod/writer/scorers.js';
import { decideClaim } from '../src/agent/biod/writer/policy.js';
import { auditManuscript } from '../src/agent/biod/writer/audit.js';
import { MANUSCRIPT_AUDIT_RENDERER_VERSION } from '../src/agent/biod/writer/contracts.js';
import { executeManuscriptAuditTool } from '../src/agent/biod/writer/tool.js';
import { RuntimeToolDispatcher } from '../src/agent/runtime_tool_dispatcher.js';
import { buildCoreToolsForAgent } from '../src/agent/core_tools_runtime.js';
import { TOOLLIBRARY_TOOL_NAME } from '../src/agent/core_tools/ids.js';

const tempDirectories: string[] = [];
after(() => {
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

const MANUSCRIPT = `# Demo

## Abstract

Marker X causes T-cell exhaustion.

## Results

In the treatment group, marker X was higher than in controls.

Fig. 2A shows marker X intensity.

## Discussion

Marker X is associated with exhaustion in mice [@smith2024].
`;

const BIB = `@article{smith2024,
  title = {Marker X in exhausted T cells},
  doi = {10.1234/example}
}
`;

const MATRIX = `claim_id,section,claim_text,claim_type,evidence_id,evidence_type,evidence_locator,evidence_quote,evidence_scope,writer_relation,writer_status,notes
C001,abstract,"Marker X causes T-cell exhaustion.",causal,E001,citation,"doi:10.1234/example","In mice, marker X expression was associated with exhausted T cells.","mouse, 8 weeks",partially_supports,partially-supported,""
C002,results,"In the treatment group, marker X was higher than in controls.",observation,E002,figure,"Fig. 2A","Fig. 2A: marker X intensity, treatment vs control, n=6 per group.","human PBMC, 24 h",supports,supported,""
C003,discussion,"Marker X is associated with exhaustion in mice.",association,E003,citation,smith2024,"In mice, marker X expression was associated with exhausted T cells.","mouse, 8 weeks",supports,supported,""
C004,results,"Marker X predicts response to therapy.",generalization,NONE,none,"","","",not_checked,needs-citation,""
`;

function tempProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-w1-'));
  tempDirectories.push(directory);
  return directory;
}

function writeProject(project: string): void {
  fs.mkdirSync(path.join(project, 'manuscript'), { recursive: true });
  fs.writeFileSync(path.join(project, 'manuscript/manuscript.md'), MANUSCRIPT, 'utf8');
  fs.writeFileSync(path.join(project, 'manuscript/claim-evidence.csv'), MATRIX, 'utf8');
  fs.writeFileSync(path.join(project, 'manuscript/references.bib'), BIB, 'utf8');
  fs.mkdirSync(path.join(project, 'manuscript/figures'), { recursive: true });
  fs.writeFileSync(path.join(project, 'manuscript/figures/Fig2A.png'), 'not-a-real-png', 'utf8');
}

function writerConfig(overrides: Partial<BiodConfig> = {}): BiodConfig {
  return {
    enabled: true,
    service: {
      baseUrl: 'http://127.0.0.1:8790',
      autoStart: false,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 200,
      contextTimeoutMs: 200,
    },
    runtime: { device: 'cpu', dtype: 'float32' },
    model: { expectedVersion: 'test' },
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
      decisionPoints: {},
      writer: {
        enabled: true,
        thresholds: { ...DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS },
        precheck: { ...DEFAULT_MANUSCRIPT_PRECHECK },
        decisionPoints: {
          'w1.claim-evidence-audit': { mode: 'assist', scorer: 'mock', budget: 'claim-audit' },
        },
      },
    },
    state: { maxChars: 220 },
    warnings: [],
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<typeof auditManuscript>[0]> = {}) {
  return {
    requestId: 'req-w1',
    runId: 'run-w1',
    role: 'writer' as const,
    manuscriptPath: 'manuscript/manuscript.md',
    matrixPath: 'manuscript/claim-evidence.csv',
    referencesPath: 'manuscript/references.bib',
    manuscriptContent: MANUSCRIPT,
    matrixContent: MATRIX,
    referencesContent: BIB,
    figures: ['Fig2A.png'],
    tables: [],
    mode: 'assist' as const,
    budget: budgetFor('claim-audit'),
    thresholds: { ...DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS },
    precheck: { ...DEFAULT_MANUSCRIPT_PRECHECK },
    context: { sessionId: 's', rolePromptVersion: 'writer-v1', rendererVersion: MANUSCRIPT_AUDIT_RENDERER_VERSION },
    ...overrides,
  };
}

test('parseClaimMatrix groups one row per claim-evidence edge', () => {
  const parsed = parseClaimMatrix(MATRIX);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.claims.length, 4);
  assert.equal(parsed.rows.length, 4);
  const c1 = parsed.claims.find((claim) => claim.claimId === 'C001');
  assert.equal(c1?.rows.length, 1);
  assert.equal(c1?.rows[0].evidenceLocator, 'doi:10.1234/example');
});

test('parseClaimMatrix rejects mixing evidence_type=none with real evidence', () => {
  const csv = MATRIX.replace(
    'C004,results,"Marker X predicts response to therapy.",generalization,NONE,none,"","","",not_checked,needs-citation,""',
    `C004,results,"Marker X predicts response to therapy.",generalization,E004,citation,doi:10.1234/example,"a quote","",supports,supported,""\nC004,results,"Marker X predicts response to therapy.",generalization,NONE,none,"","","",not_checked,needs-citation,""`,
  );
  const parsed = parseClaimMatrix(csv);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.message, /cannot mix/);
});

test('manuscript annotation finds placements and marks stale claims', () => {
  const manuscript = parseManuscript(MANUSCRIPT);
  const matrix = parseClaimMatrix(MATRIX);
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  const claims = annotateClaims(matrix.claims, manuscript);
  assert.deepEqual(claims.find((claim) => claim.claimId === 'C001')?.placements, ['abstract']);
  assert.equal(claims.find((claim) => claim.claimId === 'C004')?.stale, true);
  assert.equal(claims.find((claim) => claim.claimId === 'C004')?.sectionMismatch, false);
});

test('precheck catches missing citation keys and orphan bib entries', () => {
  const manuscript = parseManuscript(MANUSCRIPT);
  const bib = parseBibTeX(BIB);
  const matrix = parseClaimMatrix(MATRIX);
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  const claim = annotateClaims(matrix.claims, manuscript).find((item) => item.claimId === 'C001')!;
  const evidence: ClaimEvidenceRow = { ...claim.rows[0], evidenceLocator: 'missing-key' };
  const result = runPrecheck({
    claim,
    evidence,
    manuscript,
    bib,
    figures: ['Fig2A.png'],
    tables: [],
    maxQuoteChars: 800,
    referencesAvailable: true,
  });
  assert.equal(result.citationKey, 'missing');
  assert.equal(result.blocking, true);
  assert.ok(result.issues.some((issue) => issue.code === 'citation_not_in_bib'));
  assert.ok(orphanCitationKeys(manuscript, bib).includes('smith2024') === false);
});

test('renderer keeps the short state small and the budget path bounded', () => {
  const manuscript = parseManuscript(MANUSCRIPT);
  const matrix = parseClaimMatrix(MATRIX);
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  const claim = annotateClaims(matrix.claims, manuscript).find((item) => item.claimId === 'C001')!;
  const short = renderManuscriptAuditState(claim, claim.rows[0], 'short');
  assert.ok(short.state.length <= 260);
  const fitted = fitManuscriptAuditBudget('x'.repeat(10_000), budgetFor('claim-audit'));
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.estimatedTokens <= budgetFor('claim-audit').maxStateTokens);
});

test('heuristic scorer flags a causal claim supported by association evidence', async () => {
  const manuscript = parseManuscript(MANUSCRIPT);
  const matrix = parseClaimMatrix(MATRIX);
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  const claim = annotateClaims(matrix.claims, manuscript).find((item) => item.claimId === 'C001')!;
  const signal = await new HeuristicManuscriptAuditScorer().score({ claim, evidence: claim.rows[0] });
  assert.ok(signal.overclaim.includes('causality'));
  assert.ok(signal.scores.supports > signal.scores.unrelated);
});

test('policy aggregates no-evidence, mismatch, and status conflict', () => {
  const manuscript = parseManuscript(MANUSCRIPT);
  const matrix = parseClaimMatrix(MATRIX);
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  const claims = annotateClaims(matrix.claims, manuscript);
  const stale = claims.find((claim) => claim.claimId === 'C004')!;
  const staleAudit = decideClaim({ claim: stale, edges: [], thresholds: DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS });
  assert.equal(staleAudit.finding, 'stale_claim');

  const c1 = claims.find((claim) => claim.claimId === 'C001')!;
  const edge: EvidenceAudit = {
    evidenceId: 'E001',
    evidenceType: 'citation',
    locator: 'doi:10.1234/example',
    quote: 'associated',
    scope: 'mouse',
    relation: 'contradicts',
    scores: { supports: 0.1, partially_supports: 0.1, contradicts: 0.7, unrelated: 0.05, unverifiable: 0.05 },
    confidence: 0.8,
    overclaim: [],
    precheck: passingPrecheck(),
    reasons: ['test'],
    truncated: false,
    fallback: false,
  };
  const audit = decideClaim({ claim: { ...c1, writerStatus: 'supported' }, edges: [edge], thresholds: DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS });
  assert.equal(audit.finding, 'support_mismatch');
  assert.ok(audit.flags.includes('status_conflict'));
});

test('auditManuscript returns a per-claim report with P0 and stale claims', async () => {
  const result = await auditManuscript(request(), { scorer: new HeuristicManuscriptAuditScorer() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const c1 = result.report.claims.find((claim) => claim.claimId === 'C001')!;
  assert.equal(c1.finding, 'overclaim');
  assert.equal(c1.priority, 'P0');
  assert.equal(result.report.claims.find((claim) => claim.claimId === 'C004')?.finding, 'stale_claim');
  assert.match(result.markdown, /P0/);
  assert.match(result.markdown, /not a peer-review decision/);
  assert.equal(result.report.summary.stale_claim, 1);
});

test('BiodService and the toollibrary action write a report and leave the draft untouched', async () => {
  const project = tempProject();
  writeProject(project);
  const service = new BiodService({
    config: writerConfig(),
    manuscriptAuditScorer: new MockManuscriptAuditScorer(),
    manuscriptAuditLedgerFile: path.join(project, 'biod-manuscript-audit.jsonl'),
    environment: {},
  });
  const dispatcher = new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'audit the draft',
      conversationId: 'conversation-w1',
      mainAgent: { id: 'writer', promptFile: 'prompts/writer.md' } as never,
      mcpServers: [],
      skills: [],
    },
    manager: {} as never,
    mcpToolsByName: new Map(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'run-w1',
    projectPath: project,
    biod: service,
  });
  const result = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, { action: 'manuscript-audit' })).result);
  assert.equal(result.ok, true);
  assert.equal(result.reportPath, 'manuscript/audit-manuscript.md');
  assert.ok(fs.existsSync(path.join(project, 'manuscript/audit-manuscript.md')));
  assert.equal(fs.readFileSync(path.join(project, 'manuscript/claim-evidence.csv'), 'utf8'), MATRIX);
  const ledger = fs.readFileSync(path.join(project, 'biod-manuscript-audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(ledger[0]).decisionPoint, 'w1.claim-evidence-audit');
});

test('shadow mode logs the audit without writing a report', async () => {
  const project = tempProject();
  writeProject(project);
  const config = writerConfig();
  config.framework!.writer!.decisionPoints['w1.claim-evidence-audit'] = {
    mode: 'shadow',
    scorer: 'mock',
    budget: 'claim-audit',
  };
  const service = new BiodService({
    config,
    manuscriptAuditScorer: new MockManuscriptAuditScorer(),
    manuscriptAuditLedgerFile: path.join(project, 'biod-manuscript-audit.jsonl'),
    environment: {},
  });
  const dispatcher = new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'audit the draft',
      conversationId: 'conversation-w1-shadow',
      mainAgent: { id: 'writer', promptFile: 'prompts/writer.md' } as never,
      mcpServers: [],
      skills: [],
    },
    manager: {} as never,
    mcpToolsByName: new Map(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'run-w1-shadow',
    projectPath: project,
    biod: service,
  });
  const result = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, { action: 'manuscript-audit' })).result);
  assert.equal(result.ok, true);
  assert.equal(result.shadow, true);
  assert.equal(fs.existsSync(path.join(project, 'manuscript/audit-manuscript.md')), false);
  assert.ok(fs.existsSync(path.join(project, 'biod-manuscript-audit.jsonl')));
});

test('BiodService.runManuscriptAudit is disabled unless framework and writer are enabled', async () => {
  const config = writerConfig();
  delete config.framework;
  const service = new BiodService({
    config,
    manuscriptAuditScorer: new MockManuscriptAuditScorer(),
    environment: {},
  });
  const result = await service.runManuscriptAudit({
    requestId: 'r',
    runId: 'run',
    sessionId: 's',
    rolePromptVersion: 'v',
    manuscriptPath: 'manuscript/manuscript.md',
    matrixPath: 'manuscript/claim-evidence.csv',
    manuscriptContent: MANUSCRIPT,
    matrixContent: MATRIX,
    referencesContent: BIB,
    figures: [],
    tables: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'disabled');
});

test('manuscript-audit is Writer-only', async () => {
  const project = tempProject();
  writeProject(project);
  const service = new BiodService({
    config: writerConfig(),
    manuscriptAuditScorer: new MockManuscriptAuditScorer(),
    environment: {},
  });
  const dispatcher = new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'audit the draft',
      conversationId: 'conversation-w1b',
      mainAgent: { id: 'researcher', promptFile: 'prompts/researcher.md' } as never,
      mcpServers: [],
      skills: [],
    },
    manager: {} as never,
    mcpToolsByName: new Map(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'run-w1b',
    projectPath: project,
    biod: service,
  });
  const result = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, { action: 'manuscript-audit' })).result);
  assert.equal(result.ok, false);
  assert.match(result.error, /only available to the writer role/);
});

test('shipped config enables Writer W1 assist and the new budget profiles exist', () => {
  const configDirectory = fileURLToPath(new URL('../config', import.meta.url));
  const parsed = loadBiodConfig(configDirectory, {});
  assert.equal(parsed.framework?.writer?.enabled, true);
  assert.equal(parsed.framework?.writer?.decisionPoints['w1.claim-evidence-audit']?.mode, 'assist');
  assert.equal(parsed.framework?.writer?.decisionPoints['w1.claim-evidence-audit']?.budget, 'claim-audit');
  assert.equal(budgetFor('claim-audit').maxStateTokens, 2_048);
  assert.equal(budgetFor('claim-audit-max').maxTotalTokens, 32_768);
});

test('the toollibrary schema advertises manuscript-audit', () => {
  const tools = buildCoreToolsForAgent({ id: 'writer', coreToolIds: ['toollibrary'] } as never);
  const toollibrary = tools.find((tool) => tool.function.name === TOOLLIBRARY_TOOL_NAME);
  assert.ok(toollibrary);
  const action = toollibrary?.function.parameters?.properties?.action as { enum?: string[] } | undefined;
  assert.ok(action?.enum?.includes('manuscript-audit'));
});

function passingPrecheck(): PrecheckResult {
  return {
    citationKey: 'ok',
    citationMetadata: 'ok',
    retraction: 'not_checked',
    locator: 'ok',
    quote: 'ok',
    inline: 'ok',
    issues: [],
    blocking: false,
  };
}

test('the tool path decodes references.bib before the citation precheck', async () => {
  const project = tempProject();
  writeProject(project);
  const service = new BiodService({
    config: writerConfig(),
    manuscriptAuditLedgerFile: path.join(project, 'biod-manuscript-audit.jsonl'),
    environment: {},
  });
  const result = JSON.parse(await executeManuscriptAuditTool({}, {
    projectPath: project,
    agentId: 'writer',
    service,
    requestId: 'r',
    runId: 'r',
    sessionId: 's',
    rolePromptVersion: 'writer',
  }));
  assert.equal(result.ok, true);
  const markdown = fs.readFileSync(path.join(project, result.reportPath), 'utf8');
  // `.bib` is not in the project-file text mime map; a base64 read would silently produce zero
  // BibTeX entries and every citation would be reported as missing.
  assert.match(markdown, /missing citation keys: 0/);
  assert.ok(!markdown.includes('citation_key_missing'));
});
