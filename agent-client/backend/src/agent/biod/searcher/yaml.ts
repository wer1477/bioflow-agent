import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { parseSearcherArtifacts, type ArtifactIssue } from '../framework/artifacts.js';
import type { SearcherArtifacts } from '../framework/contracts.js';

/**
 * Parses the Searcher's structured `research/hypotheses.yaml`.
 *
 * The YAML is only a transport: validation stays in `parseSearcherArtifacts` so the tool and
 * the framework agree on one artifact contract. A malformed file is a visible failure, not a
 * guessed hypothesis list.
 */
export type HypothesesParseResult =
  | { ok: true; artifacts: SearcherArtifacts }
  | { ok: false; reason: 'empty_hypotheses' | 'invalid_hypotheses'; message: string; issues: ArtifactIssue[] };

export function parseHypothesesYaml(content: string): HypothesesParseResult {
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) {
    return { ok: false, reason: 'empty_hypotheses', message: 'hypotheses.yaml is empty', issues: [] };
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_hypotheses',
      message: `YAML: ${error instanceof Error ? error.message : String(error)}`,
      issues: [],
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'invalid_hypotheses',
      message: 'hypotheses.yaml must be a mapping with a hypotheses: [...] list',
      issues: [],
    };
  }

  const parsed = parseSearcherArtifacts(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: 'invalid_hypotheses',
      message: 'hypotheses.yaml does not match the S2 artifact schema',
      issues: parsed.issues,
    };
  }
  if (!parsed.artifacts.hypotheses.length) {
    return { ok: false, reason: 'empty_hypotheses', message: 'hypotheses.yaml has no hypothesis cards', issues: [] };
  }
  return { ok: true, artifacts: parsed.artifacts };
}

export function hashHypotheses(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
