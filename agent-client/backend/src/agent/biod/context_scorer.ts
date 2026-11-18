import {
  baselineScore,
  type ColdZoneGroup,
} from '../context/cold_zone.js';
import { loadBiodConfig, isBiodDisabledByEnv } from './config.js';
import { biodService, type BiodService } from './service.js';

/**
 * Cold-zone ranker backed by the biod decision model.
 *
 * The cold-zone pipeline deliberately keeps the mechanical routing (quotas, evidence
 * lines, packing, the drop threshold) in rules. The only place a learned model belongs is
 * the importance score, so this module provides exactly that replacement: one batched
 * call per compaction, a lookup keyed by group sequence, and the deterministic prior for
 * every group the service did not score.
 *
 * Contract with the caller:
 * - `null` means "no learned ranker available"; the caller must not pass a scorer at all.
 * - A returned scorer is total and never throws: unknown ids fall back to `baselineScore`.
 * - Scores are absolute relevance in [0, 1]; the caller's threshold/quota semantics are
 *   unchanged, so a bad ranking can only reorder the same machinery.
 */

const MAX_NAME_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 160;
/** The checkpoint max_len is 4096 tokens; 12 groups of ~160 Chinese chars leave room for the state. */
const MAX_STATE_CHARS = 1000;
const DEFAULT_MAX_GROUPS = 12;

export type ColdZoneScorer<T> = (group: ColdZoneGroup<T>) => number;

export async function buildBiodColdZoneScorer<T>(
  groups: ColdZoneGroup<T>[],
  taskText: string,
  service: Pick<BiodService, 'scoreGroups'> = biodService,
): Promise<ColdZoneScorer<T> | null> {
  const config = loadBiodConfig();
  const point = config.decisionPoints.context_retention;
  if (!config.enabled || point.mode === 'off' || isBiodDisabledByEnv()) return null;

  const state = taskText.replace(/\s+/g, ' ').trim().slice(0, Math.min(config.state.maxChars, MAX_STATE_CHARS));
  if (!state) return null;

  // User prompts are kept outside the cold-zone quota: scoring them would be dead work and
  // could only tempt the caller away from the "instructions are never paraphrased" rule.
  const scored = groups
    .filter((group) => group.kind !== 'user' && Boolean(String(group.text || '').trim()))
    .slice(-Math.min(point.maxGroups, DEFAULT_MAX_GROUPS));
  if (!scored.length) return null;

  const payload = scored.map((group) => {
    const tool = group.toolNames[0] || group.kind;
    const summary = String(group.summaryText || group.text || '').replace(/\s+/g, ' ').trim();
    return {
      id: String(group.seq),
      name: `${group.kind}:${tool}`.slice(0, MAX_NAME_CHARS),
      description: summary.slice(0, MAX_DESCRIPTION_CHARS),
    };
  });

  const result = await service.scoreGroups({ state, groups: payload });
  if (!result.ok) return null;

  const scores = new Map<string, number>();
  for (const item of result.scores) {
    const value = Number(item.score);
    if (Number.isFinite(value)) scores.set(item.id, Math.min(1, Math.max(0, value)));
  }
  if (!scores.size) return null;

  const total = groups.length;
  const baseline = new Map<number, number>(
    groups.map((group, index) => [
      group.seq,
      baselineScore({ kind: group.kind, outcome: group.outcome, position: index, total }),
    ]),
  );

  return (group: ColdZoneGroup<T>): number => {
    const learned = scores.get(String(group.seq));
    if (learned !== undefined) return learned;
    return baseline.get(group.seq) ?? 0.5;
  };
}
