import { loadBiodConfig } from '../biod/config.js';

/**
 * The gate a role passes before it can talk to another role.
 *
 * Three questions decide it: is the hop necessary, does the target actually own that duty,
 * and would the message cause duplicated work or an unauthorized decision. The judgement is
 * reserved on the biod sidecar as decision point `relay_select` — it is *not* implemented
 * there yet, and this file is written to be useful before it is: every failure mode of the
 * sidecar (disabled, unreachable, slow, unknown payload) escalates to the lead instead of
 * silently allowing or silently dropping a message.
 *
 * A rejection is only safe because it is not a dead end: the caller gets the reasons in its
 * tool result, the lead sees the request in its transcript, and the caller can always fall
 * back to `deliver`.
 */
export interface RelayGateRequest {
  from: string;
  to: string;
  body: string;
  /** Why the caller thinks the hop is necessary, straight from its tool call. */
  why?: string;
}

export interface RelayGateVerdict {
  verdict: 'allow' | 'reject' | 'escalate';
  /** 0..1; below the floor the lead decides. */
  confidence: number;
  reasons: string[];
  /** Where the verdict came from: `biod` or the failure that forced the fallback. */
  source: string;
}

/** Below this, biod is not confident enough to be the only judge. */
export const RELAY_CONFIDENCE_FLOOR = 0.75;

const DEFAULT_TIMEOUT_MS = 1_500;

export async function judgeRelay(
  request: RelayGateRequest,
  options: { timeoutMs?: number } = {},
): Promise<RelayGateVerdict> {
  const config = loadBiodConfig();
  if (!config.enabled) return escalate('disabled');

  const baseUrl = String(config.service.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return escalate('not_configured');

  const timeoutMs = options.timeoutMs ?? Math.min(DEFAULT_TIMEOUT_MS, config.service.requestTimeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('relay gate timeout')), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/decide/relay_select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        state: [request.from, '->', request.to, request.why ? `(${request.why})` : '', request.body].filter(Boolean).join(' ').slice(0, config.state.maxChars),
        from: request.from,
        to: request.to,
        body: request.body,
        why: request.why || '',
      }),
    });
    if (!response.ok) return escalate(`http_${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    return interpret(payload);
  } catch {
    // `abort(reason)` rejects with the reason, not an AbortError, so the signal is the only
    // reliable test for "we gave up waiting".
    return escalate(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

function interpret(payload: Record<string, unknown>): RelayGateVerdict {
  const verdict = String(payload.verdict ?? '');
  if (verdict !== 'allow' && verdict !== 'reject') return escalate('unknown_verdict');
  const confidence = Number(payload.confidence);
  if (!Number.isFinite(confidence)) return escalate('bad_response');

  const reasons = toStringList(payload.reasons);
  if (confidence < RELAY_CONFIDENCE_FLOOR) {
    return { verdict: 'escalate', confidence, reasons, source: 'low_confidence' };
  }
  return { verdict, confidence, reasons, source: 'biod' };
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${String(entry)}`)
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function escalate(reason: string): RelayGateVerdict {
  return { verdict: 'escalate', confidence: 0, reasons: [], source: reason };
}
