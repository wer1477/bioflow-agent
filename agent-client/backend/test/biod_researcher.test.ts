import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { budgetFor } from '../src/agent/biod/framework/budget.js';
import { loadBiodConfig } from '../src/agent/biod/config.js';
import { BiodService } from '../src/agent/biod/service.js';
import type { BiodConfig } from '../src/agent/biod/config.js';
import {
  DEFAULT_PLAN_AUDIT_PREFILTER,
  DEFAULT_PLAN_AUDIT_THRESHOLDS,
  NO_TOOL_ID,
  type PlanAuditRequest,
  type PlanStep,
  type PlanToolCandidate,
} from '../src/agent/biod/researcher/contracts.js';
import { buildStepCandidates, toPlanToolCandidate } from '../src/agent/biod/researcher/candidates.js';
import { auditPlan } from '../src/agent/biod/researcher/audit.js';
import { MockPlanAuditScorer } from '../src/agent/biod/researcher/scorers.js';
import { decidePlanStep } from '../src/agent/biod/researcher/policy.js';
import { parsePlanSteps } from '../src/agent/biod/researcher/plan-steps.js';
import { renderPlanAuditReport } from '../src/agent/biod/researcher/report.js';
import { fitPlanAuditBudget, renderPlanAuditState } from '../src/agent/biod/researcher/renderer.js';
import { executePlanAuditTool } from '../src/agent/biod/researcher/tool.js';
import { RuntimeToolDispatcher } from '../src/agent/runtime_tool_dispatcher.js';
import { buildCoreToolsForAgent } from '../src/agent/core_tools_runtime.js';
import { TOOLLIBRARY_TOOL_NAME } from '../src/agent/core_tools/ids.js';

const tempDirectories: string[] = [];
after(() => {
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

const TOOLS: PlanToolCandidate[] = [
  toPlanToolCandidate({
    id: 'pydeseq2',
    name: 'pydeseq2',
    kind: 'skill',
    description: 'Differential gene expression analysis (Python DESeq2). Identify DE genes from bulk RNA-seq counts with Wald tests and FDR correction.',
    domain: 'Omics and Single-Cell Analysis',
  }),
  toPlanToolCandidate({
    id: 'scanpy',
    name: 'scanpy',
    kind: 'skill',
    description: 'Standard single-cell RNA-seq analysis pipeline: QC, normalization, dimensionality reduction, clustering, differential expression, and visualization.',
    domain: 'Omics and Single-Cell Analysis',
  }),
  toPlanToolCandidate({
    id: 'bio-seq',
    name: 'bio-seq',
    kind: 'skill',
    description: 'Sequence validation and manipulation tools for DNA/RNA workflows.',
    domain: 'General Bioinformatics Workflows and Toolchains',
  }),
];

function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 'S1',
    goal: '对 counts 做差异表达',
    inputs: ['results/counts.tsv', 'metadata.tsv'],
    outputs: ['results/de.tsv'],
    constraints: ['bulk RNA-seq', 'paired design'],
    ...overrides,
  };
}

function request(overrides: Partial<PlanAuditRequest> = {}): PlanAuditRequest {
  return {
    requestId: 'req-r1',
    runId: 'run-r1',
    role: 'researcher',
    planPath: 'planning/experiment-design-demo.md',
    planHash: 'hash',
    steps: [step()],
    tools: TOOLS,
    mode: 'assist',
    budget: budgetFor('audit'),
    thresholds: { ...DEFAULT_PLAN_AUDIT_THRESHOLDS },
    prefilter: { ...DEFAULT_PLAN_AUDIT_PREFILTER },
    context: { sessionId: 'session-r1', rolePromptVersion: 'researcher-v1', rendererVersion: 'r1.plan-audit.full-v1' },
    ...overrides,
  };
}

function config(overrides: Partial<BiodConfig> = {}): BiodConfig {
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
      tool_select: { mode: 'off', tau: 0.5, noToolMargin: 0.1 },
      kb_select: { mode: 'off', tau: 0.5, topK: 3 },
      context_retention: { mode: 'off', maxGroups: 32 },
      role_select: { mode: 'off', tau: 0.6 },
      relay_select: { mode: 'off', floor: 0.75 },
    },
    framework: {
      enabled: true,
      defaultMode: 'off',
      decisionPoints: {},
      researcher: {
        enabled: true,
        thresholds: { ...DEFAULT_PLAN_AUDIT_THRESHOLDS },
        prefilter: { ...DEFAULT_PLAN_AUDIT_PREFILTER },
        decisionPoints: {
          'r1.plan-audit': { mode: 'assist', scorer: 'mock', budget: 'audit' },
        },
      },
    },
    state: { maxChars: 220 },
    warnings: [],
    ...overrides,
  };
}

function tempProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-r1-'));
  tempDirectories.push(directory);
  return directory;
}

function designDoc(): string {
  return `# Demo design

## 2. 设计
demo

## 执行步骤
\`\`\`plan-steps
version: 1
steps:
  - id: S1
    goal: "对 counts 做差异表达"
    inputs: ["results/counts.tsv", "metadata.tsv"]
    outputs: ["results/de.tsv"]
    current_tool: null
    current_approach: "手写 DESeq2 脚本"
    constraints: ["bulk RNA-seq", "paired design"]
  - id: S2
    goal: "对单细胞矩阵做 QC 和聚类"
    inputs: ["data/matrix.h5ad"]
    outputs: ["results/scanpy.h5ad"]
    current_tool: "scanpy"
    constraints: ["human"]
\`\`\`
`;
}

test('parsePlanSteps accepts the fenced contract and rejects a missing block', () => {
  const parsed = parsePlanSteps(designDoc());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.steps.length, 2);
  assert.equal(parsed.steps[0].id, 'S1');
  assert.equal(parsed.steps[0].currentToolId, undefined);
  assert.equal(parsed.steps[1].currentToolId, 'scanpy');

  const missing = parsePlanSteps('# no block');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'missing_plan_steps');

  const invalid = parsePlanSteps('```plan-steps\nversion: 1\nsteps:\n  - id: "bad id"\n    goal: x\n    inputs: []\n    outputs: []\n```');
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.reason, 'invalid_plan_steps');
});

test('buildStepCandidates keeps only role tools, pins NO_TOOL, and classifies current tools', () => {
  const library = buildStepCandidates(step({ currentToolId: 'scanpy' }), TOOLS, { mode: 'none', maxCandidates: 16 });
  assert.equal(library.currentToolKind, 'library');
  assert.ok(library.candidates.some((candidate) => candidate.id === 'scanpy' && candidate.isCurrent));
  assert.ok(library.candidates.some((candidate) => candidate.id === NO_TOOL_ID));

  const core = buildStepCandidates(step({ currentToolId: 'shell' }), TOOLS, { mode: 'none', maxCandidates: 16 });
  assert.equal(core.currentToolKind, 'core');

  const unknown = buildStepCandidates(step({ currentToolId: 'missing/tool' }), TOOLS, { mode: 'none', maxCandidates: 16 });
  assert.equal(unknown.currentToolKind, 'unknown');

  const filtered = buildStepCandidates(step(), TOOLS, { mode: 'lexical', maxCandidates: 2 });
  assert.ok(filtered.candidates.length <= 3);
  assert.ok(filtered.candidates.some((candidate) => candidate.id === NO_TOOL_ID));
});

test('renderer keeps the short state within v0 budget and preserves NO_TOOL when fitting', () => {
  const short = renderPlanAuditState(step(), TOOLS, budgetFor('audit'), 'short');
  assert.ok(short.state.length <= 220);
  assert.match(short.state, /NO_TOOL/);

  const full = renderPlanAuditState(step(), TOOLS, budgetFor('audit'), 'full');
  assert.match(full.state, /Step: 对 counts 做差异表达/);
  const fitted = fitPlanAuditBudget(full, TOOLS, budgetFor('audit'));
  assert.ok(fitted.candidates.some((candidate) => candidate.id === NO_TOOL_ID));
  assert.ok(fitted.estimatedTokens <= budgetFor('audit').maxTotalTokens);
});

test('policy labels better, keep, missing, no-tool, and uncertain cases', () => {
  const thresholds = { ...DEFAULT_PLAN_AUDIT_THRESHOLDS };
  const current = step({ currentToolId: 'scanpy' });
  const set = buildStepCandidates(current, TOOLS, { mode: 'none', maxCandidates: 16 });
  const keep = decidePlanStep(current, signal({ 'scanpy': 0.9, 'pydeseq2': 0.2, [NO_TOOL_ID]: 0.1 }), set, thresholds);
  assert.equal(keep.opportunity, 'keep_current');

  const better = decidePlanStep(current, signal({ 'scanpy': 0.1, 'pydeseq2': 0.9, [NO_TOOL_ID]: 0.1 }), set, thresholds);
  assert.equal(better.opportunity, 'better_tool');
  assert.equal(better.recommendedToolId, 'pydeseq2');
  assert.ok(better.evidence);

  const missing = decidePlanStep(step(), signal({ 'pydeseq2': 0.9, 'scanpy': 0.2, [NO_TOOL_ID]: 0.1 }), buildStepCandidates(step(), TOOLS, { mode: 'none', maxCandidates: 16 }), thresholds);
  assert.equal(missing.opportunity, 'missing_tool');

  const noTool = decidePlanStep(step(), signal({ 'pydeseq2': 0.2, 'scanpy': 0.1, [NO_TOOL_ID]: 0.8 }), buildStepCandidates(step(), TOOLS, { mode: 'none', maxCandidates: 16 }), thresholds);
  assert.equal(noTool.opportunity, 'no_tool');
  assert.ok(noTool.ranked.some((entry) => entry.id === NO_TOOL_ID));

  const uncertain = decidePlanStep(step({ inputs: [], outputs: [] }), signal({ [NO_TOOL_ID]: 0.5 }), buildStepCandidates(step({ inputs: [], outputs: [] }), TOOLS, { mode: 'none', maxCandidates: 16 }), thresholds);
  assert.equal(uncertain.opportunity, 'uncertain');
  assert.ok(uncertain.flags.includes('underspecified_step'));
});

test('auditPlan returns a report and a replay trace with a NO_TOOL row', async () => {
  const scorer = new MockPlanAuditScorer({
    S1: { 'pydeseq2': 0.9, 'scanpy': 0.2, [NO_TOOL_ID]: 0.1 },
  });
  const result = await auditPlan(request(), { scorer, thresholds: { ...DEFAULT_PLAN_AUDIT_THRESHOLDS } });
  assert.equal(result.report.steps.length, 1);
  assert.equal(result.report.steps[0].opportunity, 'missing_tool');
  assert.equal(result.report.steps[0].recommendedToolId, 'pydeseq2');
  assert.ok(result.report.steps[0].ranked.some((entry) => entry.id === NO_TOOL_ID));
  assert.equal(result.trace.steps.length, 1);
  assert.ok(result.trace.steps[0].state.length > 0);
  assert.match(renderPlanAuditReport(result.report), /## Opportunities/);
});

test('executePlanAuditTool writes a report and never edits the design document', async () => {
  const project = tempProject();
  const designPath = 'planning/experiment-design-demo.md';
  fs.mkdirSync(path.join(project, 'planning'), { recursive: true });
  const content = designDoc();
  fs.writeFileSync(path.join(project, designPath), content, 'utf8');

  const ledgerFile = path.join(project, 'biod-plan-audit.jsonl');
  const service = new BiodService({
    config: config(),
    planAuditScorer: new MockPlanAuditScorer({
      S1: { 'pydeseq2': 0.9, [NO_TOOL_ID]: 0.1 },
      S2: { 'scanpy': 0.9, [NO_TOOL_ID]: 0.1 },
    }),
    planAuditLedgerFile: ledgerFile,
    environment: {},
  });
  const result = JSON.parse(await executePlanAuditTool(
    { path: designPath },
    {
      projectPath: project,
      agentId: 'researcher',
      tools: TOOLS,
      service,
      requestId: 'req-tool',
      runId: 'run-tool',
      sessionId: 'session-tool',
      rolePromptVersion: 'researcher-v1',
    },
  ));

  assert.equal(result.ok, true);
  assert.equal(result.reportPath, 'planning/plan-audit-demo.md');
  assert.equal(fs.readFileSync(path.join(project, designPath), 'utf8'), content);
  assert.ok(fs.existsSync(path.join(project, result.reportPath)));
  const ledger = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
  assert.equal(ledger.length, 1);
  assert.equal(JSON.parse(ledger[0]).decisionPoint, 'r1.plan-audit');
});

test('executePlanAuditTool fails open for a non-researcher or a missing plan-steps block', async () => {
  const project = tempProject();
  const designPath = 'planning/experiment-design-demo.md';
  fs.mkdirSync(path.join(project, 'planning'), { recursive: true });
  fs.writeFileSync(path.join(project, designPath), '# no block', 'utf8');
  const service = new BiodService({ config: config(), planAuditScorer: new MockPlanAuditScorer(), environment: {} });
  const denied = JSON.parse(await executePlanAuditTool(
    { path: designPath },
    { projectPath: project, agentId: 'searcher', tools: TOOLS, service, requestId: 'r', runId: 'r', sessionId: 's', rolePromptVersion: 'v' },
  ));
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'not_authorized');

  const missing = JSON.parse(await executePlanAuditTool(
    { path: designPath },
    { projectPath: project, agentId: 'researcher', tools: TOOLS, service, requestId: 'r', runId: 'r', sessionId: 's', rolePromptVersion: 'v' },
  ));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_plan_steps');
});

test('shipped config enables Researcher R1 assist and parses its thresholds', () => {
  const configDirectory = fileURLToPath(new URL('../config', import.meta.url));
  const parsed = loadBiodConfig(configDirectory, {});
  assert.equal(parsed.framework?.researcher?.enabled, true);
  assert.equal(parsed.framework?.researcher?.decisionPoints['r1.plan-audit']?.mode, 'assist');
  assert.equal(parsed.framework?.researcher?.decisionPoints['r1.plan-audit']?.budget, 'audit');
  assert.equal(parsed.framework?.researcher?.thresholds.margin, 0.08);
  assert.equal(parsed.framework?.researcher?.prefilter.maxCandidates, 16);
});

test('BiodService.runPlanAudit uses the heuristic scorer without a sidecar', async () => {
  const project = tempProject();
  const designPath = 'planning/experiment-design-demo.md';
  fs.mkdirSync(path.join(project, 'planning'), { recursive: true });
  fs.writeFileSync(path.join(project, designPath), designDoc(), 'utf8');
  const cfg = config();
  cfg.framework!.researcher!.decisionPoints['r1.plan-audit'] = { mode: 'assist', scorer: 'heuristic', budget: 'audit' };
  const service = new BiodService({
    config: cfg,
    planAuditLedgerFile: path.join(project, 'heuristic-ledger.jsonl'),
    environment: {},
  });
  const result = await service.runPlanAudit({
    requestId: 'r-heuristic', runId: 'run', sessionId: 's', rolePromptVersion: 'v',
    planPath: designPath, planHash: 'h', steps: [step()], tools: TOOLS,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.report.modelVersion, 'heuristic-r1-v1');
});

test('BiodService.runPlanAudit is disabled unless both framework and researcher are enabled', async () => {
  const project = tempProject();
  const designPath = 'planning/experiment-design-demo.md';
  fs.mkdirSync(path.join(project, 'planning'), { recursive: true });
  fs.writeFileSync(path.join(project, designPath), designDoc(), 'utf8');

  const disabledConfig = config();
  delete disabledConfig.framework;
  const service = new BiodService({ config: disabledConfig, planAuditScorer: new MockPlanAuditScorer(), environment: {} });
  const result = await service.runPlanAudit({
    requestId: 'r', runId: 'run', sessionId: 's', rolePromptVersion: 'v',
    planPath: designPath, planHash: 'h', steps: [step()], tools: TOOLS,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'disabled');
});

test('the toollibrary schema advertises plan-audit', () => {
  const tools = buildCoreToolsForAgent({ id: 'researcher', coreToolIds: ['toollibrary'] } as never);
  const toollibrary = tools.find((tool) => tool.function.name === TOOLLIBRARY_TOOL_NAME);
  assert.ok(toollibrary);
  const action = toollibrary?.function.parameters?.properties?.action as { enum?: string[] } | undefined;
  assert.ok(action?.enum?.includes('plan-audit'));
});

test('toollibrary action=plan-audit is wired through the dispatcher with a role gate', async () => {
  const project = tempProject();
  const designPath = 'planning/experiment-design-demo.md';
  fs.mkdirSync(path.join(project, 'planning'), { recursive: true });
  fs.writeFileSync(path.join(project, designPath), designDoc(), 'utf8');
  const service = new BiodService({
    config: config(),
    planAuditScorer: new MockPlanAuditScorer({
      S1: { 'pydeseq2': 0.9, [NO_TOOL_ID]: 0.1 },
      S2: { 'scanpy': 0.9, [NO_TOOL_ID]: 0.1 },
    }),
    planAuditLedgerFile: path.join(project, 'ledger.jsonl'),
    environment: {},
  });
  const dispatcher = new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'audit the plan',
      conversationId: 'conversation-r1',
      mainAgent: { id: 'researcher', promptFile: 'prompts/researcher.md' } as never,
      mcpServers: [],
      skills: TOOLS.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        instructions: '',
        resources: [],
        directory: '',
      })) as never,
    },
    manager: {} as never,
    mcpToolsByName: new Map(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'run-r1',
    projectPath: project,
    biod: service,
  });
  const parsed = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, { action: 'plan-audit', path: designPath })).result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reportPath, 'planning/plan-audit-demo.md');
});

function signal(scores: Record<string, number>): {
  scores: Record<string, number>;
  confidence: number;
  abstain: boolean;
  reasons: string[];
  latencyMs: number;
} {
  return { scores, confidence: 0.9, abstain: false, reasons: ['test'], latencyMs: 0 };
}
