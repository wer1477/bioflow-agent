/**
 * Bounded run-start capability discovery (experiment module).
 *
 * One call per run, only for a role that delegates capability selection to biod. It reuses
 * an injected shortlist + sidecar decision + entrypoint resolver; it never executes a tool,
 * never loops over shell calls, and returns no card on no-match/failure.
 */
export interface DiscoveryCandidate {
  id: string;
  name: string;
  kind: 'skill' | 'mcp';
  description?: string;
  entrypoint?: string;
  contract?: { inputs: string[]; outputs: string[] };
}

export interface DiscoveryDecision {
  ok: boolean;
  chosen?: string[];
  confidence?: number;
  reason?: string;
}

export interface DiscoveryDeps {
  shortlist(message: string, candidates: DiscoveryCandidate[], limit: number): DiscoveryCandidate[];
  decide(message: string, candidates: DiscoveryCandidate[]): Promise<DiscoveryDecision>;
  resolveEntrypoint(id: string): { entrypoint?: string; contract?: { inputs: string[]; outputs: string[] } } | null;
  now?: () => number;
}

export interface DiscoveryCard {
  status: 'matched' | 'no_match' | 'fallback';
  selectedId?: string;
  entrypoint?: string;
  contract?: { inputs: string[]; outputs: string[] };
  latencyMs: number;
  contextChars: number;
  sidecarCalls: number;
  fallbackReason?: string;
}

export interface DiscoveryInput {
  message: string;
  candidates: DiscoveryCandidate[];
  roleBindsToollibrary: boolean;
  enabled: boolean;
  tau?: number;
  limit?: number;
  maxContextChars?: number;
}

const MAX_CARD = 320;
const MAX_CONTEXT = 300;

/** Render a bounded hint; never includes skill bodies or answers. */
export function renderDiscoveryCard(card: DiscoveryCard, maxChars = MAX_CONTEXT): string {
  if (card.status !== 'matched' || !card.selectedId) return '';
  const c = card.contract;
  const text = `Capability available: ${card.selectedId}; entrypoint: ${card.entrypoint ?? 'not-resolved'}; ` +
    `contract: inputs=${c ? c.inputs.join(',') : 'unknown'}, outputs=${c ? c.outputs.join(',') : 'unknown'}; ` +
    `use toollibrary select/load only if it fits; its structured summary/contract is authoritative; otherwise continue with shell.`;
  return text.slice(0, Math.min(maxChars, MAX_CARD));
}

/** One bounded preflight. A failure is a safe no-op, not a tool call. */
export async function runDiscoveryPreflight(input: DiscoveryInput, deps: DiscoveryDeps): Promise<DiscoveryCard> {
  const started = (deps.now ?? Date.now)();
  const base: DiscoveryCard = { status: 'no_match', latencyMs: 0, contextChars: 0, sidecarCalls: 0 };
  if (!input.enabled || !input.roleBindsToollibrary || !input.message.trim() || !input.candidates.length) return base;
  const shortlisted = deps.shortlist(input.message, input.candidates, Math.min(input.limit ?? 32, 32));
  if (!shortlisted.length) return { ...base, fallbackReason: 'empty_shortlist' };
  let decision: DiscoveryDecision;
  try {
    decision = await deps.decide(input.message, shortlisted);
  } catch (error) {
    return { ...base, status: 'fallback', sidecarCalls: 1, fallbackReason: error instanceof Error ? error.message : 'decision_error' };
  }
  const latencyMs = (deps.now ?? Date.now)() - started;
  if (!decision.ok || !decision.chosen?.length) {
    return { ...base, status: 'fallback', latencyMs, sidecarCalls: 1, fallbackReason: decision.reason ?? 'no_decision' };
  }
  if (decision.chosen[0] === 'NO_TOOL') return { ...base, latencyMs, sidecarCalls: 1, fallbackReason: 'no_match' };
  if ((decision.confidence ?? 0) < (input.tau ?? 0.1)) return { ...base, latencyMs, sidecarCalls: 1, fallbackReason: 'low_confidence' };
  const selected = shortlisted.find((candidate) => candidate.id === decision.chosen![0]);
  if (!selected) return { ...base, status: 'fallback', latencyMs, sidecarCalls: 1, fallbackReason: 'catalog_mismatch' };
  const resolved = deps.resolveEntrypoint(selected.id);
  const card: DiscoveryCard = {
    status: 'matched', selectedId: selected.id,
    entrypoint: resolved?.entrypoint ?? selected.entrypoint,
    contract: resolved?.contract ?? selected.contract,
    latencyMs, contextChars: 0, sidecarCalls: 1,
  };
  card.contextChars = renderDiscoveryCard(card).length;
  return card;
}
