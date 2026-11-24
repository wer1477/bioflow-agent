import { randomUUID } from 'node:crypto';
import type {
  BiodCandidate,
  BiodCandidateTransport,
  BiodCatalogMeta,
  BiodFailure,
  BiodGroupScore,
  BiodGroupScores,
  BiodKbDecision,
  BiodResult,
  BiodScore,
  BiodToolDecision,
} from './types.js';
import { candidateFingerprint, prepareCandidatePayload } from './candidate_shortlist.js';

/**
 * HTTP client for the biod sidecar.
 *
 * Two rules shape this file:
 * 1. Nothing throws. The decision layer is an accelerator; a call can only ever produce a
 *    value or a `BiodFailure`, and the reason is what the caller branches on.
 * 2. A dead sidecar must stop costing the run. After five consecutive decision failures
 *    the circuit opens for 60 s, so every later call fails immediately instead of queueing
 *    up its own socket timeout. Health/version probes still work while it is open — they
 *    are how the supervisor notices recovery — but they never open or reset the circuit.
 */

export interface HttpBiodClientOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  contextTimeoutMs: number;
  /** Decision failures needed to open the circuit. Default 5 (spec). */
  failureThreshold?: number;
  /** How long the circuit stays open. Default 60000 (spec). */
  circuitOpenMs?: number;
}

export interface BiodHealth {
  ok: boolean;
  status?: string;
  modelVersion?: string;
  error?: string;
}

export interface BiodVersion {
  ok: boolean;
  modelVersion?: string;
  /** Candidate vocabulary of the loaded checkpoint; used to mask runtime-only ids. */
  optionIds?: { tool: string[]; kb: string[] };
  /** Newer sidecars render arbitrary candidate cards, not only checkpoint ids. */
  supportsCandidateDescriptions?: boolean;
  error?: string;
}

export interface BiodClient {
  health(timeoutMs?: number): Promise<BiodHealth>;
  version(): Promise<BiodVersion>;
  decideTool(
    state: string,
    candidates: BiodCandidate[],
    policy: { tau: number },
    signal?: AbortSignal,
    catalog?: BiodCatalogMeta,
    options?: { candidates?: 'descriptions' | 'ids' },
  ): Promise<BiodResult<BiodToolDecision>>;
  decideKb(
    state: string,
    candidates: BiodCandidate[],
    policy: { tau: number; topK: number },
    signal?: AbortSignal,
    catalog?: BiodCatalogMeta,
    options?: { candidates?: 'descriptions' | 'ids' },
  ): Promise<BiodResult<BiodKbDecision>>;
  scoreGroups(
    state: string,
    groups: Array<{ id: string; name: string; description: string }>,
    signal?: AbortSignal,
  ): Promise<BiodResult<BiodGroupScores>>;
}

/** `ready` or `degraded` with a loaded model is usable; `loading` is not. */
export function isBiodHealthReady(health: BiodHealth | null | undefined): boolean {
  if (!health?.ok) return false;
  if (health.status === 'loading') return false;
  return Boolean(health.modelVersion) || health.status === 'ready';
}

type JsonResponse = { ok: true; body: unknown } | { ok: false; failure: BiodFailure };

const MAX_SCORE_GROUPS = 32;
const MAX_GROUP_NAME_CHARS = 120;
const MAX_GROUP_DESCRIPTION_CHARS = 400;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_CIRCUIT_OPEN_MS = 60_000;

export class HttpBiodClient implements BiodClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly contextTimeoutMs: number;
  private readonly failureThreshold: number;
  private readonly circuitOpenMs: number;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(options: HttpBiodClientOptions) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.requestTimeoutMs = positiveMs(options.requestTimeoutMs, 2_000);
    this.contextTimeoutMs = positiveMs(options.contextTimeoutMs, 3_000);
    this.failureThreshold = Math.max(1, Math.floor(Number(options.failureThreshold) || DEFAULT_FAILURE_THRESHOLD));
    this.circuitOpenMs = positiveMs(options.circuitOpenMs, DEFAULT_CIRCUIT_OPEN_MS);
  }

  async health(timeoutMs: number = this.requestTimeoutMs): Promise<BiodHealth> {
    const response = await this.request('/v1/health', {
      method: 'GET',
      timeoutMs,
      countsTowardCircuit: false,
    });
    if (!response.ok) return { ok: false, error: response.failure.message ?? response.failure.reason };
    const body = response.body;
    if (!isRecord(body)) return { ok: false, error: 'invalid health payload' };
    return {
      ok: body.ok === true,
      status: text(body.status),
      modelVersion: text(body.modelVersion),
      error: text(body.error) ?? (body.ok === true ? undefined : 'health check failed'),
    };
  }

  async version(): Promise<BiodVersion> {
    const response = await this.request('/v1/version', {
      method: 'GET',
      timeoutMs: this.requestTimeoutMs,
      countsTowardCircuit: false,
    });
    if (!response.ok) return { ok: false, error: response.failure.message ?? response.failure.reason };
    const body = response.body;
    if (!isRecord(body)) return { ok: false, error: 'invalid version payload' };
    const ids = isRecord(body.optionIds) ? body.optionIds : null;
    return {
      ok: body.ok === true,
      modelVersion: text(body.modelVersion),
      optionIds: ids && Array.isArray(ids.tool) && Array.isArray(ids.kb)
        ? { tool: ids.tool.filter((id): id is string => typeof id === 'string'), kb: ids.kb.filter((id): id is string => typeof id === 'string') }
        : undefined,
      supportsCandidateDescriptions: body.supportsCandidateDescriptions === true,
      error: text(body.error) ?? (body.ok === true ? undefined : 'version check failed'),
    };
  }

  async decideTool(
    state: string,
    candidates: BiodCandidate[],
    policy: { tau: number },
    signal?: AbortSignal,
    catalog?: BiodCatalogMeta,
    options?: { candidates?: 'descriptions' | 'ids' },
  ): Promise<BiodResult<BiodToolDecision>> {
    if (!candidates.length) return { ok: false, reason: 'catalog_mismatch', message: 'biod decideTool received no candidates' };
    const { response, transport } = await this.sendDecision(
      'tool', state, candidates, { tau: policy.tau }, signal, catalog, options?.candidates ?? 'descriptions',
    );
    if (!response.ok) return response.failure;
    const decision = toToolDecision(response.body, transport);
    if (!decision) {
      this.recordFailure(true);
      return { ok: false, reason: 'bad_response', message: 'invalid tool decision payload' };
    }
    return decision;
  }

  async decideKb(
    state: string,
    candidates: BiodCandidate[],
    policy: { tau: number; topK: number },
    signal?: AbortSignal,
    catalog?: BiodCatalogMeta,
    options?: { candidates?: 'descriptions' | 'ids' },
  ): Promise<BiodResult<BiodKbDecision>> {
    if (!candidates.length) return { ok: false, reason: 'catalog_mismatch', message: 'biod decideKb received no candidates' };
    const { response, transport } = await this.sendDecision(
      'kb',
      state,
      candidates,
      { tau: policy.tau, topK: policy.topK },
      signal,
      catalog,
      options?.candidates ?? 'descriptions',
    );
    if (!response.ok) return response.failure;
    const decision = toKbDecision(response.body, transport);
    if (!decision) {
      this.recordFailure(true);
      return { ok: false, reason: 'bad_response', message: 'invalid knowledge decision payload' };
    }
    return decision;
  }

  /**
   * Send one decision request with full candidate cards (or ids for a legacy sidecar).
   *
   * The mode is negotiated from `/v1/version` before the first decision; there is no
   * per-request 400 retry. The transport records what actually went on the wire.
   */
  private async sendDecision(
    kind: 'tool' | 'kb',
    state: string,
    candidates: BiodCandidate[],
    policy: Record<string, number>,
    signal: AbortSignal | undefined,
    catalog: BiodCatalogMeta | undefined,
    mode: 'descriptions' | 'ids',
  ): Promise<{ response: JsonResponse; transport: BiodCandidateTransport }> {
    const fingerprint = catalog?.fingerprint ?? candidateFingerprint(candidates);
    const prepared = mode === 'descriptions'
      ? prepareCandidatePayload(candidates)
      : { payload: candidates.map((candidate) => candidate.id), candidateCount: candidates.length, descriptionChars: 0, truncated: false };
    const transport: BiodCandidateTransport = {
      mode,
      candidateCount: prepared.candidateCount,
      descriptionChars: prepared.descriptionChars,
      truncated: prepared.truncated,
      catalogFingerprint: fingerprint,
      catalogTotal: catalog?.total ?? candidates.length,
      shortlist: prepared.candidateCount,
    };
    const response = await this.request('/v1/decide', {
      method: 'POST',
      timeoutMs: this.requestTimeoutMs,
      signal,
      countsTowardCircuit: true,
      body: {
        requestId: randomUUID(),
        kind,
        state,
        candidates: prepared.payload,
        catalog: {
          id: catalog?.id ?? (kind === 'tool' ? 'toollibrary' : 'knowledgebase'),
          fingerprint,
          total: transport.catalogTotal,
          shortlist: transport.shortlist,
          descriptionChars: transport.descriptionChars,
          truncated: transport.truncated,
        },
        policy,
      },
    });
    return { response, transport };
  }

  async scoreGroups(
    state: string,
    groups: Array<{ id: string; name: string; description: string }>,
    signal?: AbortSignal,
  ): Promise<BiodResult<BiodGroupScores>> {
    const payload = groups.slice(0, MAX_SCORE_GROUPS).map((group) => ({
      id: String(group.id),
      name: String(group.name ?? '').slice(0, MAX_GROUP_NAME_CHARS),
      description: String(group.description ?? '').slice(0, MAX_GROUP_DESCRIPTION_CHARS),
    }));
    // An empty batch is the caller's answer, not a reason to heat the GPU.
    if (!payload.length) return { ok: true, scores: [], latencyMs: 0 };

    const response = await this.request('/v1/score-groups', {
      method: 'POST',
      timeoutMs: this.contextTimeoutMs,
      signal,
      countsTowardCircuit: true,
      body: { requestId: randomUUID(), state, groups: payload },
    });
    if (!response.ok) return response.failure;
    const scores = toGroupScores(response.body);
    if (!scores) {
      this.recordFailure(true);
      return { ok: false, reason: 'bad_response', message: 'invalid score-groups payload' };
    }
    return scores;
  }

  private circuitFailure(): BiodFailure | null {
    const remainingMs = this.circuitOpenUntil - Date.now();
    if (remainingMs <= 0) return null;
    return {
      ok: false,
      reason: 'circuit_open',
      message: `biod circuit is open for another ${Math.ceil(remainingMs / 1000)}s after ${this.failureThreshold} consecutive failures`,
    };
  }

  private recordFailure(countsTowardCircuit: boolean): void {
    if (!countsTowardCircuit) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.circuitOpenUntil = Date.now() + this.circuitOpenMs;
      this.consecutiveFailures = 0;
    }
  }

  private recordSuccess(countsTowardCircuit: boolean): void {
    // Probes are diagnostics; only the decision path resets the breaker it can open.
    if (!countsTowardCircuit) return;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private async request(
    pathname: string,
    options: {
      method: 'GET' | 'POST';
      body?: unknown;
      timeoutMs: number;
      signal?: AbortSignal;
      countsTowardCircuit: boolean;
    },
  ): Promise<JsonResponse> {
    if (options.countsTowardCircuit) {
      const open = this.circuitFailure();
      if (open) return { ok: false, failure: open };
    }

    const timeoutMs = positiveMs(options.timeoutMs, this.requestTimeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const external = options.signal;
    const abortFromCaller = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', abortFromCaller, { once: true });
    }

    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${pathname}`, {
          method: options.method,
          signal: controller.signal,
          headers:
            options.body === undefined
              ? { accept: 'application/json' }
              : { accept: 'application/json', 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        const failure: BiodFailure =
          timedOut || external?.aborted
            ? { ok: false, reason: 'timeout', message: `biod ${pathname} timed out after ${timeoutMs}ms` }
            : { ok: false, reason: 'network', message: `biod ${pathname} failed: ${describeError(error)}` };
        this.recordFailure(options.countsTowardCircuit);
        return { ok: false, failure };
      }

      let rawText = '';
      try {
        rawText = await response.text();
      } catch (error) {
        const failure: BiodFailure =
          timedOut || external?.aborted
            ? { ok: false, reason: 'timeout', message: `biod ${pathname} timed out after ${timeoutMs}ms` }
            : { ok: false, reason: 'bad_response', message: `biod ${pathname} response could not be read: ${describeError(error)}` };
        this.recordFailure(options.countsTowardCircuit);
        return { ok: false, failure };
      }

      const body = parseJson(rawText);
      if (!response.ok) {
        const failure = httpFailure(pathname, response.status, body, rawText);
        // A prompt that exceeds the checkpoint encoder is an input-budget outcome,
        // not evidence that the sidecar is unhealthy: do not open the circuit for it.
        if (failure.reason !== 'prompt_too_long') this.recordFailure(options.countsTowardCircuit);
        return { ok: false, failure };
      }
      if (body === undefined) {
        this.recordFailure(options.countsTowardCircuit);
        return { ok: false, failure: { ok: false, reason: 'bad_response', message: `biod ${pathname} returned invalid JSON` } };
      }
      if (isRecord(body) && body.ok === false) {
        const failure = envelopeFailure(pathname, body.error, rawText);
        if (failure.reason !== 'prompt_too_long') this.recordFailure(options.countsTowardCircuit);
        return { ok: false, failure };
      }
      this.recordSuccess(options.countsTowardCircuit);
      return { ok: true, body };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', abortFromCaller);
    }
  }
}

function httpFailure(pathname: string, status: number, body: unknown, rawText: string): BiodFailure {
  const envelope = errorEnvelope(body, rawText);
  if (envelope.code === 'CKPT_MISMATCH') return { ok: false, reason: 'catalog_mismatch', message: envelope.message };
  if (envelope.code === 'MODEL_NOT_READY') return { ok: false, reason: 'not_ready', message: envelope.message };
  if (envelope.code === 'TIMEOUT') return { ok: false, reason: 'timeout', message: envelope.message };
  if (envelope.code === 'PROMPT_TOO_LONG') return { ok: false, reason: 'prompt_too_long', message: envelope.message };
  return {
    ok: false,
    reason: 'bad_response',
    message: `biod ${pathname} returned HTTP ${status}${envelope.code ? ` (${envelope.code})` : ''}${envelope.message ? `: ${envelope.message}` : ''}`,
  };
}

function envelopeFailure(pathname: string, error: unknown, rawText: string): BiodFailure {
  const envelope = errorEnvelope({ error }, rawText);
  if (envelope.code === 'CKPT_MISMATCH') return { ok: false, reason: 'catalog_mismatch', message: envelope.message };
  if (envelope.code === 'MODEL_NOT_READY') return { ok: false, reason: 'not_ready', message: envelope.message };
  if (envelope.code === 'TIMEOUT') return { ok: false, reason: 'timeout', message: envelope.message };
  if (envelope.code === 'PROMPT_TOO_LONG') return { ok: false, reason: 'prompt_too_long', message: envelope.message };
  return {
    ok: false,
    reason: 'bad_response',
    message: `biod ${pathname} reported a failure${envelope.code ? ` (${envelope.code})` : ''}${envelope.message ? `: ${envelope.message}` : ''}`,
  };
}

function errorEnvelope(body: unknown, rawText: string): { code: string; message: string } {
  if (isRecord(body) && isRecord(body.error)) {
    return { code: text(body.error.code) ?? '', message: text(body.error.message) ?? '' };
  }
  // A proxy or a crash can answer non-JSON; the code may still be greppable in the body.
  const code = /CKPT_MISMATCH/.test(rawText)
    ? 'CKPT_MISMATCH'
    : /MODEL_NOT_READY/.test(rawText)
      ? 'MODEL_NOT_READY'
      : '';
  return { code, message: '' };
}

function toToolDecision(body: unknown, transport: BiodCandidateTransport): BiodToolDecision | undefined {
  if (!isRecord(body)) return undefined;
  const chosen = stringArray(body.chosen);
  const scores = scoreArray(body.scores);
  const confidence = number(body.confidence);
  if (!chosen || !scores || confidence === undefined) return undefined;
  return {
    ok: true,
    decisionId: text(body.decisionId) ?? '',
    chosen,
    scores,
    confidence,
    noToolProb: number(body.noToolProb) ?? 0,
    latencyMs: number(body.latencyMs) ?? 0,
    modelVersion: text(body.modelVersion) ?? '',
    candidateCount: number(body.candidateCount) ?? scores.length,
    transport: transportFrom(body.transport, transport),
  };
}

function toKbDecision(body: unknown, transport: BiodCandidateTransport): BiodKbDecision | undefined {
  if (!isRecord(body)) return undefined;
  const chosen = stringArray(body.chosen);
  const scores = scoreArray(body.scores);
  const confidence = number(body.confidence);
  if (!chosen || !scores || confidence === undefined) return undefined;
  return {
    ok: true,
    decisionId: text(body.decisionId) ?? '',
    chosen,
    scores,
    confidence,
    latencyMs: number(body.latencyMs) ?? 0,
    modelVersion: text(body.modelVersion) ?? '',
    candidateCount: number(body.candidateCount) ?? scores.length,
    transport: transportFrom(body.transport, transport),
  };
}

function toGroupScores(body: unknown): BiodGroupScores | undefined {
  if (!isRecord(body) || !Array.isArray(body.scores)) return undefined;
  const scores: BiodGroupScore[] = [];
  for (const item of body.scores) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    const score = number(item.score);
    if (id === undefined || score === undefined) continue;
    scores.push({ id, score });
  }
  return { ok: true, scores, latencyMs: number(body.latencyMs) ?? 0 };
}

function scoreArray(value: unknown): BiodScore[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scores: BiodScore[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    const p = number(item.p);
    if (id === undefined || p === undefined) continue;
    scores.push({ id, p });
  }
  return scores;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function transportFrom(value: unknown, fallback: BiodCandidateTransport): BiodCandidateTransport {
  if (!isRecord(value)) return fallback;
  const mode = value.mode === 'ids' || value.mode === 'descriptions' ? value.mode : fallback.mode;
  const count = nonNegativeNumber(value.candidateCount) ?? fallback.candidateCount;
  const chars = nonNegativeNumber(value.descriptionChars) ?? fallback.descriptionChars;
  return {
    mode,
    candidateCount: count,
    descriptionChars: chars,
    truncated: typeof value.truncated === 'boolean' ? value.truncated : fallback.truncated,
    catalogFingerprint: text(value.catalogFingerprint) ?? fallback.catalogFingerprint,
    catalogTotal: nonNegativeNumber(value.catalogTotal) ?? fallback.catalogTotal,
    shortlist: nonNegativeNumber(value.shortlist) ?? fallback.shortlist,
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function parseJson(rawText: string): unknown {
  if (!rawText.trim()) return undefined;
  try {
    return JSON.parse(rawText);
  } catch {
    return undefined;
  }
}

function positiveMs(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}
