import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { RuntimeToolDispatcher } from '../src/agent/runtime_tool_dispatcher.js';
import { buildResidentTools } from '../src/agent/resident_tools.js';
import { buildCoreToolsPrompt } from '../src/agent/core_tools_runtime.js';
import {
  capabilitySelectionMode,
  capabilitySelectionModes,
  isCapabilityCoreToolId,
  residentCoreToolIds,
} from '../src/agent/core_tools/capability_selection.js';
import {
  KNOWLEDGEBASE_TOOL_NAME,
  TOOLLIBRARY_CORE_TOOL_ID,
  TOOLLIBRARY_TOOL_NAME,
  TOOLLOAD_TOOL_NAME,
} from '../src/agent/core_tools/ids.js';
import type { BiodKbDecision, BiodToolDecision } from '../src/agent/biod/types.js';
import * as agentConfigStore from '../src/agent/config/agent_config_store.js';

/**
 * The capability families are the one exception to "a CoreTool is loaded only when it is
 * bound": tool library and knowledge base stay resident for every role. Binding them routes
 * selection to biod; leaving them out degrades the same call to a browse result the model
 * chooses from, and a biod failure keeps that browse path as its fail-open fallback.
 */

const skill = {
  id: 'bio-seq',
  name: 'bio-seq',
  description: 'Sequence validation tools.',
  instructions: 'Use bio-seq for sequence work.',
  resources: [],
  directory: '',
};

function toolDecision(overrides: Partial<BiodToolDecision> = {}): BiodToolDecision {
  return {
    ok: true,
    decisionId: 'dec_tool_1',
    chosen: ['bio-seq'],
    scores: [{ id: 'bio-seq', p: 0.91 }],
    confidence: 0.91,
    noToolProb: 0.02,
    latencyMs: 410,
    modelVersion: 'biod-v0-final',
    candidateCount: 53,
    ...overrides,
  };
}

function kbDecision(overrides: Partial<BiodKbDecision> = {}): BiodKbDecision {
  return {
    ok: true,
    decisionId: 'dec_kb_1',
    chosen: ['Bioinformatics/anndata'],
    scores: [{ id: 'Bioinformatics/anndata', p: 0.88 }],
    confidence: 0.88,
    latencyMs: 240,
    modelVersion: 'biod-v0-final',
    candidateCount: 32,
    ...overrides,
  };
}

function createDispatcher(options: {
  /** Omit to simulate a caller without an Agent profile (the pre-configuration behavior). */
  coreToolIds?: string[];
  knowledgeEntryIds?: string[];
  biod?: {
    decideTool?: () => Promise<BiodToolDecision>;
    decideKnowledge?: () => Promise<BiodKbDecision>;
  };
} = {}): RuntimeToolDispatcher {
  const mainAgent = options.coreToolIds === undefined && options.knowledgeEntryIds === undefined
    ? undefined
    : {
      id: 'main',
      ...(options.coreToolIds === undefined ? {} : { coreToolIds: options.coreToolIds }),
      ...(options.knowledgeEntryIds === undefined ? {} : { knowledgeEntryIds: options.knowledgeEntryIds }),
    };
  return new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'Use scanpy to cluster the single-cell matrix.',
      mcpServers: [],
      skills: [skill] as never,
      ...(mainAgent ? { mainAgent: mainAgent as never } : {}),
    },
    manager: {} as never,
    mcpToolsByName: new Map<string, ChatCompletionTool>(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'test-run',
    ...(options.biod
      ? { biod: { decideTool: options.biod.decideTool, decideKnowledge: options.biod.decideKnowledge } as never }
      : {}),
  });
}

test('capability families are appended to every explicit CoreTool list', () => {
  assert.deepEqual(residentCoreToolIds(['shell']), ['shell', TOOLLIBRARY_CORE_TOOL_ID, KNOWLEDGEBASE_TOOL_NAME]);
  assert.deepEqual(residentCoreToolIds([]), [TOOLLIBRARY_CORE_TOOL_ID, KNOWLEDGEBASE_TOOL_NAME]);
  assert.deepEqual(
    residentCoreToolIds(['knowledgebase', 'shell']),
    ['knowledgebase', 'shell', TOOLLIBRARY_CORE_TOOL_ID],
    'an ordered list keeps its entries and only appends what is missing',
  );
  assert.equal(residentCoreToolIds(undefined), undefined, 'no profile keeps the install-everything sentinel');

  assert.equal(isCapabilityCoreToolId(TOOLLIBRARY_CORE_TOOL_ID), true);
  assert.equal(isCapabilityCoreToolId(KNOWLEDGEBASE_TOOL_NAME), true);
  assert.equal(isCapabilityCoreToolId('shell'), false);
});

test('the resident schema set keeps the capability families for an unconfigured role', () => {
  const bound = buildResidentTools(['shell']).map((tool) => tool.function.name);
  for (const name of [TOOLLIBRARY_TOOL_NAME, TOOLLOAD_TOOL_NAME, KNOWLEDGEBASE_TOOL_NAME]) {
    assert.ok(bound.includes(name), `${name} must stay resident even when the role does not bind it`);
  }
  assert.ok(!bound.includes('read_file'), 'an unbound non-capability CoreTool stays out of the request');

  const all = buildResidentTools().map((tool) => tool.function.name);
  assert.ok(all.includes(TOOLLIBRARY_TOOL_NAME), 'a caller without a profile still installs every CoreTool');
});

test('the settings projection marks the capability families as always available', () => {
  const tools = agentConfigStore.getAllCoreTools();
  const alwaysAvailable = tools.filter((tool) => tool.alwaysAvailable).map((tool) => tool.id).sort();
  assert.deepEqual(alwaysAvailable, [KNOWLEDGEBASE_TOOL_NAME, TOOLLIBRARY_CORE_TOOL_ID].sort());
});

test('selection mode follows the binding and defaults to biod without a profile', () => {
  assert.equal(capabilitySelectionMode(['toollibrary'], TOOLLIBRARY_CORE_TOOL_ID), 'biod');
  assert.equal(capabilitySelectionMode(['toollibrary'], KNOWLEDGEBASE_TOOL_NAME), 'llm');
  assert.equal(capabilitySelectionMode(undefined, TOOLLIBRARY_CORE_TOOL_ID), 'biod');
  assert.deepEqual(capabilitySelectionModes([]), { toollibrary: 'llm', knowledgebase: 'llm' });
  assert.deepEqual(capabilitySelectionModes(['toollibrary', 'knowledgebase']), { toollibrary: 'biod', knowledgebase: 'biod' });
});

test('the capability prompt fragment follows the selection mode', () => {
  const biod = buildCoreToolsPrompt([TOOLLIBRARY_CORE_TOOL_ID]) || '';
  assert.match(biod, /runtime decision model picks/);

  const llm = buildCoreToolsPrompt(
    [TOOLLIBRARY_CORE_TOOL_ID, KNOWLEDGEBASE_TOOL_NAME],
    { capabilitySelection: { toollibrary: 'llm', knowledgebase: 'llm' } },
  ) || '';
  assert.match(llm, /you choose/);
  assert.match(llm, /not delegated to the runtime decision model/);
  assert.doesNotMatch(llm, /runtime decision model picks/);
  assert.match(llm, /Knowledge Base is available for this role/);
});

test('an unconfigured role browses instead of calling biod', async () => {
  let toolCalls = 0;
  let kbCalls = 0;
  const dispatcher = createDispatcher({
    coreToolIds: ['shell'],
    knowledgeEntryIds: [],
    biod: {
      decideTool: async () => { toolCalls += 1; return toolDecision(); },
      decideKnowledge: async () => { kbCalls += 1; return kbDecision(); },
    },
  });

  const tool = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, {})).result);
  assert.equal(tool.ok, true);
  assert.equal(tool.action, 'index');
  assert.deepEqual(tool.biod, { status: 'off', reason: 'not_configured' });
  assert.equal(toolCalls, 0, 'the unconfigured role must not ask biod');

  // `action` defaults to select, so an empty call is the "hand it to biod" path too.
  const knowledge = JSON.parse((await dispatcher.execute(KNOWLEDGEBASE_TOOL_NAME, {})).result);
  assert.equal(knowledge.ok, true);
  assert.equal(knowledge.action, 'index');
  assert.deepEqual(knowledge.biod, { status: 'off', reason: 'not_configured' });
  assert.equal(kbCalls, 0, 'the unconfigured role must not ask biod');
});

test('an unconfigured role can still load a capability the model picked', async () => {
  const dispatcher = createDispatcher({ coreToolIds: ['shell'], knowledgeEntryIds: [] });

  const index = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, {})).result);
  const domain = (index.domains as Array<{ name: string; tools: number }>).find((entry) => entry.tools > 0)?.name;
  assert.ok(domain, 'the browse result must name a domain the model can open');

  const catalog = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, { action: 'catalog', domain })).result);
  assert.equal(catalog.ok, true);
  assert.equal(catalog.action, 'catalog');
  assert.ok(catalog.entries.some((entry: { id: string }) => entry.id === 'bio-seq'));

  const loaded = JSON.parse((await dispatcher.execute(TOOLLOAD_TOOL_NAME, { id: 'bio-seq' })).result);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.action, 'skill');
});

test('a configured role still hands selection to biod', async () => {
  let toolCalls = 0;
  const dispatcher = createDispatcher({
    coreToolIds: ['toollibrary', 'shell'],
    knowledgeEntryIds: ['Bioinformatics/anndata'],
    biod: {
      decideTool: async () => { toolCalls += 1; return toolDecision(); },
      decideKnowledge: async () => kbDecision(),
    },
  });

  const parsed = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, {})).result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'select');
  assert.equal(parsed.selected.id, 'bio-seq');
  assert.equal(parsed.decision.decisionId, 'dec_tool_1');
  assert.equal(toolCalls, 1);
});
