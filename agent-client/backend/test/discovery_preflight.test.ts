import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDiscoveryCard, runDiscoveryPreflight, type DiscoveryCandidate, type DiscoveryDeps } from '../src/agent/discovery_preflight.js';

const candidates: DiscoveryCandidate[] = [{ id: 'bulk-contrast', name: 'bulk-contrast', kind: 'skill', description: 'contrast' }];
function deps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    shortlist: (_m, cs) => cs,
    decide: async () => ({ ok: true, chosen: ['bulk-contrast'], confidence: 1 }),
    resolveEntrypoint: (id) => ({ entrypoint: `/skills/${id}.py`, contract: { inputs: ['matrix'], outputs: ['contrast.csv'] } }),
    now: () => 100,
    ...overrides,
  };
}
const base = { message: 'compute contrast', candidates, roleBindsToollibrary: true, enabled: true };

test('matched card has entrypoint and contract, bounded', async () => {
  const card = await runDiscoveryPreflight(base, deps());
  assert.equal(card.status, 'matched');
  assert.equal(card.selectedId, 'bulk-contrast');
  assert.match(card.entrypoint ?? '', /bulk-contrast\.py/);
  const text = renderDiscoveryCard(card, 120);
  assert.ok(text.length <= 120);
  assert.ok(!text.includes('mean_control'));
});

test('NO_TOOL is no_match, not a forced selection', async () => {
  const card = await runDiscoveryPreflight(base, deps({ decide: async () => ({ ok: true, chosen: ['NO_TOOL'], confidence: 1 }) }));
  assert.equal(card.status, 'no_match');
});

test('sidecar failure is fallback, no card text', async () => {
  const card = await runDiscoveryPreflight(base, deps({ decide: async () => { throw new Error('timeout'); } }));
  assert.equal(card.status, 'fallback');
  assert.equal(renderDiscoveryCard(card), '');
});

test('low confidence is no_match', async () => {
  const card = await runDiscoveryPreflight({ ...base, tau: 0.5 }, deps({ decide: async () => ({ ok: true, chosen: ['bulk-contrast'], confidence: 0.2 }) }));
  assert.equal(card.status, 'no_match');
});

test('disabled or unbound role is a no-op', async () => {
  assert.equal((await runDiscoveryPreflight({ ...base, enabled: false }, deps())).status, 'no_match');
  assert.equal((await runDiscoveryPreflight({ ...base, roleBindsToollibrary: false }, deps())).status, 'no_match');
});
