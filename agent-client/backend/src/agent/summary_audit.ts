import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_STATE_ROOT } from '../paths.js';

/**
 * Minimal, de-identified audit for every internal summariser completion.
 *
 * Compaction calls `completeText` outside the normal stream path, so their tokens and
 * latency are invisible to the per-run telemetry unless recorded here. The record keeps
 * only wire facts the provider actually returned; missing usage stays null, never 0.
 */
export interface SummaryAuditContext {
  conversationId?: string | null;
  runId?: string | null;
  trigger: string;
  checkpointId?: string | null;
}

export interface SummaryCallRecord extends SummaryAuditContext {
  ts: string;
  requestId: string;
  protocol: string;
  maxTokens: number;
  finishReason: string | null;
  contentChars: number;
  reasoningChars: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
  reasoningTokens: number | null;
  latencyMs: number;
  outcome: 'ok' | 'empty' | 'invalid_json' | 'invalid_schema' | 'error';
  attempts?: number;
  compatRetry?: boolean;
  error?: string;
}

const AUDIT_FILE = path.join(RUNTIME_STATE_ROOT, 'summary-calls.jsonl');

export function appendSummaryCall(record: SummaryCallRecord): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Audit is diagnostics: a read-only workspace must never fail compaction.
  }
}

export function summaryAuditPath(): string {
  return AUDIT_FILE;
}
