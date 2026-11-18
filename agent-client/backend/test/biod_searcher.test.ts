import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBiodConfig, type BiodConfig } from '../src/agent/biod/config.js';
import { BiodService } from '../src/agent/biod/service.js';
import { executeHypothesisScreenTool } from '../src/agent/biod/searcher/tool.js';
import { parseHypothesesYaml } from '../src/agent/biod/searcher/yaml.js';
import { RuntimeToolDispatcher } from '../src/agent/runtime_tool_dispatcher.js';
import { buildCoreToolsForAgent } from '../src/agent/core_tools_runtime.js';
import { TOOLLIBRARY_TOOL_NAME } from '../src/agent/core_tools/ids.js';

const tempDirectories: string[] = [];
after(() => {
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

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
        's2.premise': { mode: 'assist', scorer: 'heuristic', budget: 'short' },
        's2.rerank': { mode: 'assist', scorer: 'heuristic', budget: 'long' },
        's2.policy': { mode: 'assist', budget: 'rule' },
        's3.trigger': { mode: 'off', budget: 'rule' },
        's5.diversity': { mode: 'off', budget: 'rule' },
      },
    },
    state: { maxChars: 220 },
    warnings: [],
    ...overrides,
  };
}

function hypothesesYaml(): string {
  return [
    'rq: Does X drive Y in treated samples?',
    'reviewSummary: Prior work suggests X is involved in Y regulation.',
    'gaps: [G1, G2, G3]',
    'hypotheses:',
    '  - id: H1',
    '    gapIds: [G1]',
    '    claim: X increases Y in treated samples',
    '    mechanism: X activates the Y promoter',
    '    premises:',
    '      - {pid: p1, text: X is increased after treatment, type: empirical}',
    '    predictions:',
    '      - {text: Y rises after X activation, readout: qPCR, direction: up, falsifier: no change}',
    '    evidenceLinks:',
    '      - {eid: E1, relation: supports}',
    '    alternatives: [Reverse causation]',
    '    feasibility: {assay: qPCR, sample: n=12, time: 2 weeks, costTier: low}',
    '  - id: H2',
    '    gapIds: [G2]',
    '    claim: X does not change Y in treated samples',
    '    premises:',
    '      - {pid: p1, text: X is unchanged after treatment, type: empirical}',
    '    predictions:',
    '      - {text: Y is unchanged after X activation, readout: qPCR, direction: flat, falsifier: change}',
    '    evidenceLinks:',
    '      - {eid: E2, relation: supports}',
    '    alternatives: [Technical batch effect]',
    '  - id: H3',
    '    gapIds: [G3]',
    '    claim: Y decreases when X increases',
    '    premises:',
    '      - {pid: p1, text: Y decreases while X increases, type: empirical}',
    '    predictions:',
    '      - {text: Y falls as X rises, readout: qPCR, direction: down, falsifier: no change}',
    '    evidenceLinks:',
    '      - {eid: E3, relation: supports}',
    '    alternatives: [Confounding by dose]',
    '  - id: H4',
    '    gapIds: [G1]',
    '    claim: X increases Y through a dose-dependent mechanism',
    '    premises:',
    '      - {pid: p1, text: X increases Y, type: empirical}',
    '    predictions:',
    '      - {text: Higher X gives higher Y, readout: qPCR, direction: up, falsifier: no dose response}',
    '    evidenceLinks:',
    '      - {eid: E1, relation: supports}',
    '    alternatives: [Saturation]',
    'evidence:',
    '  - {id: E1, locator: Fig 1A, snippet: "X increased after treatment", studyDesign: case-control, effect: "2-fold", limitations: "small n"}',
    '  - {id: E2, locator: Fig 2B, snippet: "no evidence of change", studyDesign: case-control, effect: "none", limitations: "underpowered"}',
    '  - {id: E3, locator: Fig 3C, snippet: "X increased while Y decreased", studyDesign: case-control, effect: "opposite", limitations: "single dose"}',
  ].join('\n');
}

function tempProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-searcher-'));
  tempDirectories.push(directory);
  return directory;
}

function writeHypotheses(project: string, content = hypothesesYaml()): string {
  fs.mkdirSync(path.join(project, 'research'), { recursive: true });
  const target = path.join(project, 'research', 'hypotheses.yaml');
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

function service(project: string, cfg = config()): BiodService {
  return new BiodService({
    config: cfg,
    decisionsFile: path.join(project, 'decisions.jsonl'),
    hypothesisScreenLedgerFile: path.join(project, 'screen-ledger.jsonl'),
    environment: {},
  });
}

test('parseHypothesesYaml accepts the S2 schema and rejects a malformed matrix', () => {
  const valid = parseHypothesesYaml(hypothesesYaml());
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.artifacts.hypotheses.length, 4);
  assert.equal(valid.artifacts.evidence.length, 3);
  assert.equal(valid.artifacts.gaps?.length, 3);

  const empty = parseHypothesesYaml('   ');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, 'empty_hypotheses');

  const broken = parseHypothesesYaml('hypotheses: [unclosed');
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.reason, 'invalid_hypotheses');

  const unknownEvidence = parseHypothesesYaml(hypothesesYaml().replace('eid: E3', 'eid: E404'));
  assert.equal(unknownEvidence.ok, false);
  if (!unknownEvidence.ok) {
    assert.equal(unknownEvidence.reason, 'invalid_hypotheses');
    assert.ok(unknownEvidence.issues.some((issue) => issue.message.includes('E404')));
  }
});

test('BiodService.runHypothesisScreen is disabled when every S2 core decision point is off', async () => {
  const project = tempProject();
  const cfg = config();
  cfg.framework!.decisionPoints['s2.premise'] = { mode: 'off' };
  cfg.framework!.decisionPoints['s2.rerank'] = { mode: 'off' };
  cfg.framework!.decisionPoints['s2.policy'] = { mode: 'off' };
  const parsed = parseHypothesesYaml(hypothesesYaml());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const result = await service(project, cfg).runHypothesisScreen({
    requestId: 'r',
    runId: 'run',
    sessionId: 's',
    rolePromptVersion: 'searcher',
    hypothesesPath: 'research/hypotheses.yaml',
    hypothesesHash: 'hash',
    artifacts: parsed.artifacts,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'disabled');
});

test('BiodService.runHypothesisScreen runs the heuristic S2 pipeline and writes a ledger record', async () => {
  const project = tempProject();
  const parsed = parseHypothesesYaml(hypothesesYaml());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const result = await service(project).runHypothesisScreen({
    requestId: 'r-screen',
    runId: 'run-screen',
    sessionId: 's',
    rolePromptVersion: 'searcher',
    hypothesesPath: 'research/hypotheses.yaml',
    hypothesesHash: 'hash',
    artifacts: parsed.artifacts,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.mode, 'assist');
  assert.equal(result.report.modelVersion, 'heuristic-v1');
  assert.equal(result.report.summary.cards, 4);
  assert.equal(result.report.summary.premises, 4);
  assert.equal(result.report.summary.verdicts.supported, 2);
  assert.equal(result.report.summary.verdicts.contradicted, 1);
  assert.equal(result.report.summary.verdicts.unknown, 1);
  assert.equal(result.report.summary.ranked.length, 4);
  assert.equal(result.report.summary.deferred.length, 1);
  assert.equal(result.report.summary.deferred[0]?.id, 'H3');
  assert.match(result.markdown, /假设筛选报告/);
  assert.match(result.markdown, /H3/);

  const ledger = fs.readFileSync(path.join(project, 'screen-ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledger.length, 1);
  const record = JSON.parse(ledger[0]) as { decisionPoint: string; mode: string; summary: { cards: number } };
  assert.equal(record.decisionPoint, 's2.hypothesis-screen');
  assert.equal(record.mode, 'assist');
  assert.equal(record.summary.cards, 4);
});

test('BiodService.runHypothesisScreen in shadow mode still screens but writes no report file', async () => {
  const project = tempProject();
  const cfg = config();
  for (const key of ['s2.premise', 's2.rerank', 's2.policy'] as const) {
    cfg.framework!.decisionPoints[key] = { mode: 'shadow' };
  }
  const parsed = parseHypothesesYaml(hypothesesYaml());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const result = await service(project, cfg).runHypothesisScreen({
    requestId: 'r-shadow',
    runId: 'run-shadow',
    sessionId: 's',
    rolePromptVersion: 'searcher',
    hypothesesPath: 'research/hypotheses.yaml',
    hypothesesHash: 'hash',
    artifacts: parsed.artifacts,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.mode, 'shadow');
  assert.equal(result.report.summary.cards, 4);
});

test('executeHypothesisScreenTool writes the assist report and never edits the YAML', async () => {
  const project = tempProject();
  const hypothesesPath = writeHypotheses(project);
  const before = fs.readFileSync(hypothesesPath, 'utf8');

  const output = JSON.parse(await executeHypothesisScreenTool(
    { path: 'research/hypotheses.yaml' },
    {
      projectPath: project,
      agentId: 'searcher',
      service: service(project),
      requestId: 'r-tool',
      runId: 'run-tool',
      sessionId: 's',
      rolePromptVersion: 'searcher',
    },
  )) as { ok: boolean; reportPath?: string; summary?: { cards: number } };

  assert.equal(output.ok, true);
  assert.equal(output.reportPath, 'research/hypothesis-screen-hypotheses.md');
  assert.equal(output.summary?.cards, 4);
  assert.equal(fs.readFileSync(hypothesesPath, 'utf8'), before);
  const report = fs.readFileSync(path.join(project, 'research', 'hypothesis-screen-hypotheses.md'), 'utf8');
  assert.match(report, /假设筛选报告/);
  assert.match(report, /不是 gate/);
});

test('executeHypothesisScreenTool fails open on role, file and schema errors', async () => {
  const project = tempProject();
  writeHypotheses(project);
  const denied = JSON.parse(await executeHypothesisScreenTool(
    { path: 'research/hypotheses.yaml' },
    { projectPath: project, agentId: 'researcher', service: service(project), requestId: 'r', runId: 'run', sessionId: 's', rolePromptVersion: 'researcher' },
  )) as { ok: boolean; reason: string };
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'not_authorized');

  const missing = JSON.parse(await executeHypothesisScreenTool(
    { path: 'research/missing.yaml' },
    { projectPath: project, agentId: 'searcher', service: service(project), requestId: 'r', runId: 'run', sessionId: 's', rolePromptVersion: 'searcher' },
  )) as { ok: boolean; reason: string };
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_hypotheses');

  const invalidProject = tempProject();
  writeHypotheses(invalidProject, 'hypotheses: [unclosed');
  const invalid = JSON.parse(await executeHypothesisScreenTool(
    { path: 'research/hypotheses.yaml' },
    { projectPath: invalidProject, agentId: 'searcher', service: service(invalidProject), requestId: 'r', runId: 'run', sessionId: 's', rolePromptVersion: 'searcher' },
  )) as { ok: boolean; reason: string };
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid_hypotheses');
});

test('executeHypothesisScreenTool in shadow mode returns counts but writes no report', async () => {
  const project = tempProject();
  writeHypotheses(project);
  const cfg = config();
  for (const key of ['s2.premise', 's2.rerank', 's2.policy'] as const) {
    cfg.framework!.decisionPoints[key] = { mode: 'shadow' };
  }

  const output = JSON.parse(await executeHypothesisScreenTool(
    { path: 'research/hypotheses.yaml' },
    {
      projectPath: project,
      agentId: 'searcher',
      service: service(project, cfg),
      requestId: 'r-shadow-tool',
      runId: 'run-shadow-tool',
      sessionId: 's',
      rolePromptVersion: 'searcher',
    },
  )) as { ok: boolean; shadow?: boolean; reportPath?: string; summary?: { shortlist?: string[]; shortlistCount?: number } };

  assert.equal(output.ok, true);
  assert.equal(output.shadow, true);
  assert.equal(output.reportPath, undefined);
  assert.equal(output.summary?.shortlist, undefined);
  assert.equal(output.summary?.shortlistCount, 3);
  assert.equal(fs.existsSync(path.join(project, 'research', 'hypothesis-screen-hypotheses.md')), false);
});

test('the toollibrary schema advertises hypothesis-screen for the searcher', () => {
  const tools = buildCoreToolsForAgent({ id: 'searcher', coreToolIds: ['toollibrary'] } as never);
  const toollibrary = tools.find((tool) => tool.function.name === TOOLLIBRARY_TOOL_NAME);
  assert.ok(toollibrary);
  const action = toollibrary?.function.parameters?.properties?.action as { enum?: string[] } | undefined;
  assert.ok(action?.enum?.includes('hypothesis-screen'));
});

test('toollibrary action=hypothesis-screen is wired through the dispatcher with a role gate', async () => {
  const project = tempProject();
  writeHypotheses(project);
  const dispatcher = new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'screen the hypotheses',
      conversationId: 'conversation-s2',
      mainAgent: { id: 'searcher', promptFile: 'prompts/searcher.md' } as never,
      mcpServers: [],
      skills: [],
    },
    manager: {} as never,
    mcpToolsByName: new Map(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'run-s2',
    projectPath: project,
    biod: service(project),
  });

  const parsed = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, {
    action: 'hypothesis-screen',
    path: 'research/hypotheses.yaml',
  })).result) as { ok: boolean; reportPath?: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reportPath, 'research/hypothesis-screen-hypotheses.md');

  const wrongRole = new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'screen the hypotheses',
      conversationId: 'conversation-s2-wrong',
      mainAgent: { id: 'researcher', promptFile: 'prompts/researcher.md' } as never,
      mcpServers: [],
      skills: [],
    },
    manager: {} as never,
    mcpToolsByName: new Map(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'run-s2-wrong',
    projectPath: project,
    biod: service(project),
  });
  const denied = JSON.parse((await wrongRole.execute(TOOLLIBRARY_TOOL_NAME, {
    action: 'hypothesis-screen',
    path: 'research/hypotheses.yaml',
  })).result) as { ok: boolean; error: string };
  assert.equal(denied.ok, false);
  assert.match(denied.error, /only available to the searcher role/);
});

test('the shipped config enables S2 assist and keeps optional S3/S5 off', () => {
  const configDirectory = fileURLToPath(new URL('../config', import.meta.url));
  const parsed = loadBiodConfig(configDirectory, {});
  assert.equal(parsed.framework?.enabled, true);
  assert.equal(parsed.framework?.decisionPoints['s2.premise']?.mode, 'assist');
  assert.equal(parsed.framework?.decisionPoints['s2.rerank']?.mode, 'assist');
  assert.equal(parsed.framework?.decisionPoints['s2.policy']?.mode, 'assist');
  assert.equal(parsed.framework?.decisionPoints['s3.trigger']?.mode, 'off');
  assert.equal(parsed.framework?.decisionPoints['s5.diversity']?.mode, 'off');
});
