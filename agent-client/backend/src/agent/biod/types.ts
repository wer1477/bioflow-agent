/**
 * Wire types for the biod decision sidecar.
 *
 * The runtime treats biod as an optional accelerator: every entry point returns a
 * `BiodResult<T>`, so callers never handle exceptions and the failure reason is the only
 * thing they branch on. Reasons are a closed set because they leak into tool results and
 * transcripts; adding one is a contract change, not a log tweak.
 */

/** A decision the sidecar is allowed to make. `context_retention` is a batch ranker. */
export type BiodDecisionPoint = 'tool_select' | 'kb_select' | 'context_retention';

/** One capability or knowledge entry, in the shape both renderers and biod understand. */
export interface BiodCandidate {
  id: string;
  name: string;
  description: string;
  kind?: 'skill' | 'mcp' | 'kb';
}

/** A pointwise score. Higher is better; `p` is a probability in [0, 1]. */
export interface BiodScore {
  id: string;
  p: number;
}

export interface BiodToolDecision {
  ok: true;
  decisionId: string;
  /** Ranked ids; `['NO_TOOL']` means the model prefers not loading anything. */
  chosen: string[];
  scores: BiodScore[];
  confidence: number;
  noToolProb: number;
  latencyMs: number;
  modelVersion: string;
  candidateCount: number;
}

export interface BiodKbDecision {
  ok: true;
  decisionId: string;
  chosen: string[];
  scores: BiodScore[];
  confidence: number;
  latencyMs: number;
  modelVersion: string;
  candidateCount: number;
}

export type BiodFailureReason =
  | 'disabled'
  | 'not_configured'
  | 'not_ready'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'catalog_mismatch'
  | 'circuit_open'
  | 'model_mismatch';

export interface BiodFailure {
  ok: false;
  reason: BiodFailureReason;
  message?: string;
}

export type BiodResult<T> = T | BiodFailure;

/** Cold-zone ranking result: one absolute relevance score per submitted group. */
export interface BiodGroupScore {
  id: string;
  score: number;
}

export interface BiodGroupScores {
  ok: true;
  scores: BiodGroupScore[];
  latencyMs: number;
}

export function isBiodFailure<T>(result: BiodResult<T>): result is BiodFailure {
  return (result as BiodFailure).ok === false;
}
