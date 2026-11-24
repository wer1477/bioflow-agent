import { createHash } from 'node:crypto';
import type { BiodCandidate, BiodCatalogMeta } from './types.js';
import { CROSS_LINGUAL_TERMS } from './cross_lingual_terms.js';

/**
 * Native candidate preparation for `tool_select` / `kb_select`.
 *
 * The decision model runs outside the main model, so the catalog is not in the main
 * context. That only works if the shortlist forwarded to the sidecar is small enough to
 * bound its own prompt cost, and if the descriptions survive the trip. This module keeps
 * all three concerns together:
 *
 * - a deterministic lexical shortlist over the full live catalog (recall observable);
 * - a per-request character/count budget for the sidecar prompt (cost observable);
 * - a SHA-256 identity over the full catalog cards (version/provenance observable).
 *
 * The shortlist is deliberately lexical and dependency-free: it is a routing prefilter,
 * not a scientific ranker. The sidecar still makes the final choice, including NO_TOOL.
 */

export const NATIVE_SHORTLIST_LIMIT = 32;
export const NATIVE_CANDIDATE_LIMIT = 64;
export const CANDIDATE_DESCRIPTION_MAX_CHARS = 512;
export const CANDIDATE_TOTAL_DESCRIPTION_MAX_CHARS = 16_384;
const CANDIDATE_NAME_MAX_CHARS = 160;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'use', 'using', 'with',
  'data', 'file', 'files', 'run', 'tool', 'tools', 'analysis', 'result', 'results',
]);

export interface ShortlistResult {
  candidates: BiodCandidate[];
  /** Cosine scores for the returned candidates, by id. Diagnostic only. */
  scores: Map<string, number>;
  /** `none` means there was no reliable lexical signal and no cut was trusted. */
  signal: 'lexical' | 'none';
  total: number;
  limit: number;
  dropped: number;
  /** Why the catalog order was used when `signal` is `none`. */
  fallback: 'none' | 'no_lexical_signal';
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Terms for mixed Chinese/Latin text.
 *
 * A Latin run is one term. A CJK run becomes per-character unigrams plus adjacent
 * bigrams: treating a whole Chinese sentence as one token makes paraphrases score zero
 * and would silently turn the shortlist into an alphabetical cut. Bigrams are the
 * smallest unit that still carries word-order information without a dictionary.
 */
function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  for (const run of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!CJK.test(run)) {
      tokens.push(run);
      continue;
    }
    const chars = [...run];
    for (let index = 0; index < chars.length; index += 1) {
      if (CJK.test(chars[index])) {
        tokens.push(chars[index]);
        const next = chars[index + 1];
        if (next && CJK.test(next)) tokens.push(chars[index] + next);
      } else {
        // Mixed run: keep a Latin/digit chunk as one term.
        let cursor = index;
        while (cursor < chars.length && !CJK.test(chars[cursor])) cursor += 1;
        const chunk = chars.slice(index, cursor).join('');
        if (chunk) tokens.push(chunk);
        index = cursor - 1;
      }
    }
  }
  return tokens.filter((token) =>
    (token.length >= 2 || CJK.test(token)) && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

/**
 * Query terms plus English equivalents for Chinese concepts present in the query.
 *
 * The English side is what makes a real English catalog reachable from a Chinese
 * request; Chinese terms that do not occur in the catalog simply carry idf 0 and drop
 * out of the cosine, so they add no false signal by themselves.
 */
export function expandQueryTerms(text: string): string[] {
  const base = terms(text);
  const normalized = text.normalize('NFKC').toLowerCase();
  const seen = new Set(base);
  for (const [chinese, english] of CROSS_LINGUAL_TERMS) {
    if (!normalized.includes(chinese)) continue;
    for (const token of terms(english)) {
      if (seen.has(token)) continue;
      seen.add(token);
      base.push(token);
    }
  }
  return base;
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

interface Vector {
  weights: Map<string, number>;
  norm: number;
}

function buildVector(counts: Map<string, number>, idf: Map<string, number>): Vector {
  const weights = new Map<string, number>();
  let norm = 0;
  for (const [token, count] of counts) {
    const weight = (1 + Math.log(count)) * (idf.get(token) ?? 0);
    if (weight <= 0) continue;
    weights.set(token, weight);
    norm += weight * weight;
  }
  return { weights, norm: Math.sqrt(norm) };
}

/**
 * Rank candidate cards against the task state with TF-IDF cosine.
 *
 * Ties are broken by id so the shortlist is byte-for-byte reproducible for a fixed
 * catalog and state. An empty state or a catalog at/below the limit keeps catalog order.
 */
export function shortlistCandidates(
  state: string,
  candidates: BiodCandidate[],
  limit: number = NATIVE_SHORTLIST_LIMIT,
): ShortlistResult {
  const capped = Math.max(1, Math.min(Math.floor(limit), NATIVE_CANDIDATE_LIMIT));
  const scores = new Map<string, number>();
  const queryTerms = expandQueryTerms(state);
  if (candidates.length <= capped) {
    for (const candidate of candidates) scores.set(candidate.id, 0);
    return {
      candidates: [...candidates],
      scores,
      signal: queryTerms.length ? 'lexical' : 'none',
      total: candidates.length,
      limit: capped,
      dropped: 0,
      fallback: 'none',
    };
  }
  if (!queryTerms.length) {
    return catalogOrder(candidates, capped, scores);
  }

  const corpus = candidates.map((candidate) => terms(`${candidate.name} ${candidate.description}`));
  const documentFrequency = new Map<string, number>();
  for (const tokens of corpus) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = candidates.length;
  const idf = new Map<string, number>();
  for (const [token, count] of documentFrequency) {
    idf.set(token, Math.log((1 + total) / (1 + count)) + 1);
  }

  const query = buildVector(termCounts(queryTerms), idf);
  const ranked = candidates.map((candidate, index) => {
    const vector = buildVector(termCounts(corpus[index]), idf);
    const norm = query.norm * vector.norm;
    let score = 0;
    if (norm > 0) {
      for (const [token, weight] of query.weights) {
        score += weight * (vector.weights.get(token) ?? 0);
      }
      score /= norm;
    }
    scores.set(candidate.id, Number.isFinite(score) ? score : 0);
    return { candidate, score };
  });
  if (!ranked.some((row) => row.score > 0)) {
    // A zero over the whole catalog is not a ranking. Do not pretend alphabetical
    // order is a shortlist; the caller must fall back instead of trusting the cut.
    return catalogOrder(candidates, capped, scores);
  }
  ranked.sort((left, right) => (right.score - left.score) || left.candidate.id.localeCompare(right.candidate.id));
  const selected = ranked.slice(0, capped).map((row) => row.candidate);
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  for (const id of [...scores.keys()]) {
    if (!selectedIds.has(id)) scores.delete(id);
  }
  return {
    candidates: selected,
    scores,
    signal: 'lexical',
    total: candidates.length,
    limit: capped,
    dropped: candidates.length - selected.length,
    fallback: 'none',
  };
}

/** Deterministic catalog order, explicitly marked as a non-ranking fallback. */
function catalogOrder(
  candidates: BiodCandidate[],
  capped: number,
  scores: Map<string, number>,
): ShortlistResult {
  const selected = candidates.slice(0, capped);
  for (const candidate of selected) scores.set(candidate.id, 0);
  return {
    candidates: selected,
    scores,
    signal: 'none',
    total: candidates.length,
    limit: capped,
    dropped: candidates.length - selected.length,
    fallback: 'no_lexical_signal',
  };
}

/** SHA-256 over the full catalog cards, independent of input order. */
export function candidateFingerprint(candidates: BiodCandidate[]): string {
  const rows = [...candidates]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => [
      candidate.id,
      candidate.name,
      candidate.description,
      candidate.kind ?? '',
      candidate.domain ?? '',
      candidate.version ?? '',
    ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function catalogMeta(
  id: string,
  total: number,
  candidates: BiodCandidate[],
  shortlist: number,
): BiodCatalogMeta {
  return { id, total, shortlist, fingerprint: candidateFingerprint(candidates) };
}

export interface CandidatePayload {
  payload: Array<Record<string, string>>;
  candidateCount: number;
  descriptionChars: number;
  truncated: boolean;
}

/** Bound the wire payload; the full catalog identity is carried separately. */
export function prepareCandidatePayload(candidates: BiodCandidate[]): CandidatePayload {
  const payload: Array<Record<string, string>> = [];
  let descriptionChars = 0;
  let truncated = false;
  for (const candidate of candidates) {
    if (payload.length >= NATIVE_CANDIDATE_LIMIT) {
      truncated = true;
      break;
    }
    const id = String(candidate.id ?? '').trim();
    if (!id) {
      truncated = true;
      continue;
    }
    const name = String(candidate.name ?? id).slice(0, CANDIDATE_NAME_MAX_CHARS);
    let description = String(candidate.description ?? '');
    if (description.length > CANDIDATE_DESCRIPTION_MAX_CHARS) {
      description = description.slice(0, CANDIDATE_DESCRIPTION_MAX_CHARS);
      truncated = true;
    }
    const remaining = CANDIDATE_TOTAL_DESCRIPTION_MAX_CHARS - descriptionChars;
    if (description.length > remaining) {
      description = remaining > 0 ? description.slice(0, remaining) : '';
      truncated = true;
    }
    descriptionChars += description.length;
    const row: Record<string, string> = { id, name, description };
    if (candidate.kind) row.kind = candidate.kind;
    if (candidate.domain) row.domain = candidate.domain;
    if (candidate.version) row.version = candidate.version;
    payload.push(row);
  }
  return { payload, candidateCount: payload.length, descriptionChars, truncated };
}
