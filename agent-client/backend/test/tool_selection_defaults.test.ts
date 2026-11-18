import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadBiodConfig } from '../src/agent/biod/config.js';
import { KNOWLEDGEBASE_TOOL_NAME } from '../src/agent/core_tools/ids.js';
import { capabilitySelectionMode } from '../src/agent/core_tools/capability_selection.js';
import { TOOLLIBRARY_CORE_TOOL_ID } from '../src/agent/core_tools_runtime.js';

const CONFIG_DIR = fileURLToPath(new URL('../config', import.meta.url));

/**
 * Shipped defaults for capability selection.
 *
 * Tool selection was paused (2026-11-07): the model browses the catalog itself, and
 * knowledge selection keeps its biod decision point. Making this a test, not a comment,
 * means a settings-page change or a config edit cannot silently restore the old path.
 */
test('shipped roles hand tool-library selection back to the model', () => {
  const document = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'agents.json'), 'utf8')) as {
    agents: Array<{ id: string; coreToolIds: string[] }>;
  };
  assert.ok(document.agents.length >= 2);
  for (const agent of document.agents) {
    assert.equal(
      capabilitySelectionMode(agent.coreToolIds, TOOLLIBRARY_CORE_TOOL_ID),
      'llm',
      `role '${agent.id}' must let the model choose its capabilities`,
    );
    assert.equal(
      capabilitySelectionMode(agent.coreToolIds, KNOWLEDGEBASE_TOOL_NAME),
      'biod',
      `role '${agent.id}' must keep the knowledge-base decision point unchanged`,
    );
  }
});

test('shipped biod.json pauses tool_select and keeps the other decision points', () => {
  const config = loadBiodConfig(CONFIG_DIR, {});
  assert.equal(config.decisionPoints.tool_select.mode, 'off');
  assert.equal(config.decisionPoints.kb_select.mode, 'select');
  assert.equal(config.decisionPoints.context_retention.mode, 'select');
});
