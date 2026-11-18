/**
 * Fail-open HTTP boundary for the `biod-mt-v2` role heads.
 *
 * The four audit pipelines share three endpoints:
 *   POST /v1/score-pairs        H6 pair relation + H7 overclaim flags
 *   POST /v1/decide             tool pointer (Researcher R1)
 *   POST /v1/decide/role_select 5-way owner routing (Reviewer V1)
 *
 * The model is an accelerator, never a gate: every call resolves to a `HeadResult` and the
 * role scorers turn a failure into an abstain signal. An HTTP error, a timeout or a
 * malformed payload must not throw into a role run. Request shapes are intentionally the
 * only place the wire contract is written down; see `Biod/docs/role-heads.md` §7.
 */

import { PAIR_RELATIONS, asPairRelation, type PairRelation } from './labels.js';

/** Version advertised by the sidecar that serves the two trained heads. */
export const ROLE_HEAD_MODEL_VERSION = 'biod-mt-v2';

export interface HeadScorerOptions {
  baseUrl: string;
  /** Per-call timeout; the scorer factory passes `service.pairTimeoutMs`/`requestTimeoutMs`. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type PairTask = 'premise_judge' | 'overclaim_flag';

/** One pair judgment. `unit` tells the head which relation space the pair belongs to. */
export interface PairItem {
  id: string;
  left: string;
  right: string;
  context?: string;
  unit: 'hypothesis' | 'claim' | 'issue';
}

export interface PairScoreItem {
  id: string;
  /** `null`/absent for `overclaim_flag`, which only returns `flags`. */
  label?: string;
  flags: string[];
  confidence?: number;
  probs?: Record<string, number>;
}

export interface PairScoreResponse {
  items: PairScoreItem[];
  modelVersion?: string;
  latencyMs?: number;
}

export interface ToolDecisionResponse {
  chosen: string[];
  scores: Array<{ id: string; p: number }>;
  confidence: number;
  noToolProb: number;
  modelVersion?: string;
  latencyMs?: number;
}

export interface RoleSelectResponse {
  role?: string;
  scores: Array<{ role: string; p: number }>;
  confidence: number;
  modelVersion?: string;
  latencyMs?: number;
}

export type HeadResult<T> =
  | { ok: true; value: T; latencyMs: number }
  | { ok: false; reason: string; latencyMs: number };

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Thin client for the three sidecar endpoints. The constructor deliberately throws when no
 * base URL is configured: a silently dead HTTP scorer would abstain forever, which is much
 * harder to notice than a construction error at the call site.
 */
export class RoleHeadClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HeadScorerOptions) {
    const baseUrl = String(options?.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!baseUrl) throw new Error('biod role-head client requires service.baseUrl');
    this.baseUrl = baseUrl;
    this.timeoutMs = positiveMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async scorePairs(
    task: PairTask,
    items: PairItem[],
    timeoutMs: number = this.timeoutMs,
  ): Promise<HeadResult<PairScoreResponse>> {
    if (!items.length) return { ok: false, reason: 'no_items', latencyMs: 0 };
    const response = await this.post('/v1/score-pairs', { task, items }, timeoutMs);
    if (!response.ok) return response;
    const value = toPairScoreResponse(response.value);
    if (!value) return { ok: false, reason: 'bad_response', latencyMs: response.latencyMs };
    return { ok: true, value, latencyMs: response.latencyMs };
  }

  async decideTool(
    state: string,
    candidateIds: string[],
    timeoutMs: number = this.timeoutMs,
  ): Promise<HeadResult<ToolDecisionResponse>> {
    if (!candidateIds.length) return { ok: false, reason: 'no_candidates', latencyMs: 0 };
    const response = await this.post(
      '/v1/decide',
      {
        kind: 'tool',
        state,
        role: 'researcher',
        candidates: candidateIds.map((id) => ({ id })),
      },
      timeoutMs,
    );
    if (!response.ok) return response;
    const value = toToolDecisionResponse(response.value);
    if (!value) return { ok: false, reason: 'bad_response', latencyMs: response.latencyMs };
    return { ok: true, value, latencyMs: response.latencyMs };
  }

  async selectRole(state: string, timeoutMs: number = this.timeoutMs): Promise<HeadResult<RoleSelectResponse>> {
    const response = await this.post('/v1/decide/role_select', { state }, timeoutMs);
    if (!response.ok) return response;
    const value = toRoleSelectResponse(response.value);
    if (!value) return { ok: false, reason: 'bad_response', latencyMs: response.latencyMs };
    return { ok: true, value, latencyMs: response.latencyMs };
  }

  private async post(pathname: string, body: unknown, timeoutMs: number): Promise<HeadResult<unknown>> {
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, positiveMs(timeoutMs, this.timeoutMs));
    timer.unref?.();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(body),
        });
      } catch {
        return { ok: false, reason: timedOut ? 'timeout' : 'network', latencyMs: Date.now() - started };
      }

      let raw = '';
      try {
        raw = await response.text();
      } catch {
        return { ok: false, reason: timedOut ? 'timeout' : 'bad_response', latencyMs: Date.now() - started };
      }
      if (!response.ok) {
        return { ok: false, reason: `http_${response.status}`, latencyMs: Date.now() - started };
      }
      const parsed = parseJson(raw);
      if (parsed === undefined) {
        return { ok: false, reason: 'bad_response', latencyMs: Date.now() - started };
      }
      if (isRecord(parsed) && parsed.ok === false) {
        return { ok: false, reason: 'server_error', latencyMs: Date.now() - started };
      }
      return { ok: true, value: parsed, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Normalize one pair result into the five-class H6 distribution.
 *
 * `probs` wins when it carries at least one positive relation score. Older/short responses
 * that only carry `label` + `confidence` are expanded to the same distribution so callers
 * never branch on the payload shape. Returns `undefined` when the item is unusable.
 */
export function pairProbabilities(item: PairScoreItem): Record<PairRelation, number> | undefined {
  const probs = item.probs;
  if (probs) {
    const values = {} as Record<PairRelation, number>;
    let total = 0;
    for (const relation of PAIR_RELATIONS) {
      const raw = probs[relation];
      const value = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
      values[relation] = value;
      total += value;
    }
    if (total > 0) {
      for (const relation of PAIR_RELATIONS) values[relation] /= total;
      return values;
    }
  }
  const label = asPairRelation(String(item.label ?? ''));
  if (!label) return undefined;
  const confidence = clamp01(item.confidence ?? 1 / PAIR_RELATIONS.length);
  const rest = (1 - confidence) / (PAIR_RELATIONS.length - 1);
  const expanded = {} as Record<PairRelation, number>;
  for (const relation of PAIR_RELATIONS) expanded[relation] = relation === label ? confidence : rest;
  return expanded;
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Look up the echoed item; a single-item response is accepted even if the id drifts. */
export function findPairItem(
  result: HeadResult<PairScoreResponse>,
  id: string,
): PairScoreItem | undefined {
  if (!result.ok) return undefined;
  return result.value.items.find((entry) => entry.id === id)
    ?? (result.value.items.length === 1 ? result.value.items[0] : undefined);
}

function toPairScoreResponse(body: unknown): PairScoreResponse | undefined {
  if (!isRecord(body) || !Array.isArray(body.items)) return undefined;
  const items: PairScoreItem[] = [];
  for (const raw of body.items) {
    if (!isRecord(raw)) continue;
    const id = text(raw.id);
    if (!id) continue;
    const item: PairScoreItem = { id, flags: stringArray(raw.flags) };
    const label = text(raw.label);
    if (label) item.label = label;
    const confidence = finiteNumber(raw.confidence);
    if (confidence !== undefined) item.confidence = confidence;
    if (isRecord(raw.probs)) item.probs = numericRecord(raw.probs);
    items.push(item);
  }
  const modelVersion = text(body.modelVersion);
  const latencyMs = finiteNumber(body.latencyMs);
  return {
    items,
    ...(modelVersion ? { modelVersion } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}

function toToolDecisionResponse(body: unknown): ToolDecisionResponse | undefined {
  if (!isRecord(body) || !Array.isArray(body.scores)) return undefined;
  const scores = idScoreArray(body.scores);
  const confidence = finiteNumber(body.confidence);
  if (!scores || confidence === undefined) return undefined;
  const modelVersion = text(body.modelVersion);
  const latencyMs = finiteNumber(body.latencyMs);
  return {
    chosen: stringArray(body.chosen),
    scores,
    confidence,
    noToolProb: finiteNumber(body.noToolProb) ?? 0,
    ...(modelVersion ? { modelVersion } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}

function toRoleSelectResponse(body: unknown): RoleSelectResponse | undefined {
  if (!isRecord(body)) return undefined;
  const scores = roleScoreArray(body.scores);
  const confidence = finiteNumber(body.confidence);
  if (!scores || confidence === undefined) return undefined;
  const role = text(body.role);
  const modelVersion = text(body.modelVersion);
  const latencyMs = finiteNumber(body.latencyMs);
  return {
    ...(role ? { role } : {}),
    scores,
    confidence,
    ...(modelVersion ? { modelVersion } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}

function idScoreArray(value: unknown): Array<{ id: string; p: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const scores: Array<{ id: string; p: number }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id);
    const p = finiteNumber(entry.p);
    if (id === undefined || p === undefined) continue;
    scores.push({ id, p });
  }
  return scores;
}

function roleScoreArray(value: unknown): Array<{ role: string; p: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const scores: Array<{ role: string; p: number }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const role = text(entry.role);
    const p = finiteNumber(entry.p);
    if (role === undefined || p === undefined) continue;
    scores.push({ role, p });
  }
  return scores;
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const number = finiteNumber(entry);
    if (number !== undefined) result[key] = number;
  }
  return result;
}

function parseJson(raw: string): unknown {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function positiveMs(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
