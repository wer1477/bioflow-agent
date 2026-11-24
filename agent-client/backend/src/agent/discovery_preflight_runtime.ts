import path from 'node:path';
import { loadBiodConfig } from './biod/config.js';
import { buildBiodState } from './biod/state.js';
import { catalogMeta, shortlistCandidates } from './biod/candidate_shortlist.js';
import { biodService } from './biod/service.js';
import type { BiodCandidate } from './biod/types.js';
import type { AgentRuntimeContext } from './service/agent_context_resolver.js';
import { renderDiscoveryCard, runDiscoveryPreflight, type DiscoveryCard, type DiscoveryCandidate } from './discovery_preflight.js';
import { executeToolLoad } from './core_tools/toollibrary_executor.js';
import { TOOLLIBRARY_ROOT } from '../paths.js';

const ENTRYPOINTS: Record<string, string> = {
  'bulk-contrast': 'bulk_contrast.py',
  'geo-contract': 'geo_contract.py',
  'artifact-guard': 'artifact_guard.py',
};
const CONTRACTS: Record<string, { inputs: string[]; outputs: string[] }> = {
  'bulk-contrast': { inputs: ['matrix', 'contract', 'groups'], outputs: ['contrast.csv', 'contrast.summary.json'] },
  'geo-contract': { inputs: ['matrix', 'soft'], outputs: ['contract.json'] },
  'artifact-guard': { inputs: ['accepted-artifact', 'v1-input', 'v2-input'], outputs: ['prov-v1.json', 'verify-v1.json', 'prov-v2.json', 'version.json'] },
};

export interface DiscoveryRuntimeResult {
  card: DiscoveryCard;
  text: string;
  materialized_chars: number;
  instructions: string;
}

/** One bounded preflight; returns null when disabled/unbound/no-match/fallback. */
export async function maybeDiscoveryPreflight(input: {
  context: AgentRuntimeContext;
  userMessage: string;
  messages: Array<{ role: string; content: unknown }>;
}): Promise<DiscoveryRuntimeResult | null> {
  if (process.env.BIOFLOW_DISCOVERY_PREFLIGHT !== '1') return null;
  const config = loadBiodConfig();
  if (!config.enabled || config.decisionPoints.tool_select.mode !== 'select') return null;
  if (!input.context.coreTools.some((tool) => tool.id === 'toollibrary')) return null;
  const candidates: BiodCandidate[] = input.context.skills
    .filter((skill) => skill.enabled)
    .map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, kind: 'skill' as const }));
  const discoveryCandidates: DiscoveryCandidate[] = candidates.map((candidate) => ({
    id: candidate.id, name: candidate.name, description: candidate.description, kind: 'skill',
  }));
  const state = buildBiodState({ userMessage: input.userMessage, messages: input.messages, maxChars: config.state.maxChars });
  if (!state || !candidates.length) return null;
  const short = shortlistCandidates(state, candidates, 32);
  const catalog = catalogMeta('toollibrary', candidates.length, candidates, short.candidates.length);
  const card = await runDiscoveryPreflight({
    message: state, candidates: discoveryCandidates, roleBindsToollibrary: true, enabled: true,
    tau: config.decisionPoints.tool_select.tau, limit: 32,
  }, {
    shortlist: () => short.candidates as unknown as DiscoveryCandidate[],
    decide: async () => {
      const decision = await biodService.decideTool({ state, candidates: short.candidates, role: input.context.agent.id, catalog });
      return decision.ok
        ? { ok: true, chosen: decision.chosen, confidence: decision.confidence }
        : { ok: false, reason: decision.reason };
    },
    resolveEntrypoint: (id) => {
      const skill = input.context.skills.find((candidate) => candidate.id === id);
      const dir = skill?.directory;
      const file = ENTRYPOINTS[id];
      return { entrypoint: dir && file ? path.join(dir, file) : dir, contract: CONTRACTS[id] };
    },
  });
  if (card.status !== 'matched') return null;
  const cardText = renderDiscoveryCard(card);
  if (!cardText) return null;
  // Reuse the native skill loader, once, to materialize the selected capability's
  // instructions. This does not execute the asset and does not call the sidecar again.
  let instructions = '';
  try {
    const loaded = executeToolLoad({ id: card.selectedId }, {
      root: TOOLLIBRARY_ROOT,
      skills: input.context.skills as never,
      mcpServers: [],
      mcpTools: new Map(),
    });
    if (loaded.result && loaded.result.ok && typeof loaded.result.content === 'string') {
      instructions = String(loaded.result.content);
    }
  } catch {
    instructions = '';
  }
  const bounded = instructions.slice(0, 2200);
  const text = cardText + (bounded ? `\n\nMaterialized capability (bounded, not executed):\n${bounded}` : '');
  card.contextChars = text.length;
  return { card, text, materialized_chars: bounded.length, instructions: bounded };
}
