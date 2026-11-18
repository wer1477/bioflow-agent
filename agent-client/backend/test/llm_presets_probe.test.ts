import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProbeStatus, resolvePresetEndpoint } from '../scripts/probe-presets.mjs';

/**
 * `scripts/probe-presets.mjs` is an operator tool, but its judgement is what turns an HTTP code
 * into "this preset is usable from here". Getting that mapping wrong is how a blocked provider
 * looks healthy, so the two pure functions are covered here instead of only by reading the table.
 */
test('an unauthenticated answer maps onto the four preset states', () => {
  assert.equal(classifyProbeStatus(200), 'open');
  assert.equal(classifyProbeStatus(401), 'needs-key');
  assert.equal(classifyProbeStatus(403), 'needs-key');
  assert.equal(classifyProbeStatus(404), 'path-missing');
  assert.equal(classifyProbeStatus(429), 'http-429');
  assert.equal(classifyProbeStatus(Number.NaN), 'unreachable');
});

test('the endpoint is the overlay override, or the catalog api, trimmed of trailing slashes', () => {
  const catalog = {
    openai: { api: 'https://api.openai.com/v1' },
    minimax: { api: 'https://api.minimax.io/anthropic/v1' },
    'local-only': {},
  };
  assert.equal(resolvePresetEndpoint({ id: 'openai' }, catalog), 'https://api.openai.com/v1');
  assert.equal(resolvePresetEndpoint({ id: 'minimax', api: 'https://api.minimax.io/v1/' }, catalog), 'https://api.minimax.io/v1');
  assert.equal(resolvePresetEndpoint({ id: 'fireworks-ai' }, { 'fireworks-ai': { api: 'https://api.fireworks.ai/inference/v1/' } }), 'https://api.fireworks.ai/inference/v1');
  assert.equal(resolvePresetEndpoint({ id: 'ollama', api: 'http://127.0.0.1:11434/v1' }, catalog), 'http://127.0.0.1:11434/v1');
  assert.equal(resolvePresetEndpoint({ id: 'local-only' }, catalog), '');
});
