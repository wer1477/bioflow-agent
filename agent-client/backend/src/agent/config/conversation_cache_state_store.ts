import fs from 'node:fs';
import path from 'node:path';
import { findSessionProjectKey } from './conversation_file_store.js';
import { sessionDirectory } from './session_paths.js';

/**
 * Per-conversation state that decides whether the next request can reuse the provider's
 * prefix cache: the tool set installed so far, and the system prompt it was assembled from.
 *
 * ## Tool set
 *
 * The runtime builds its `tools` array fresh on every run and only the resident core tools
 * are re-declared, so a capability the model loaded in run N disappears in run N+1. That is
 * not just a capability regression: the chat template renders tool declarations **before**
 * the system message, so shrinking the array moves every later token and the provider's
 * prefix cache misses from token 0 — for the whole conversation, on the first request of
 * every run.
 *
 * Re-declaring the previously activated tools in their original order keeps the array
 * monotonic per conversation. It is still not free: the run that first activates a tool
 * changes the array and pays one full re-prefill. The point is that the array only ever
 * grows, so the cost is O(activations) instead of O(runs).
 *
 * `BIOFLOW_TOOL_SET_STABILITY=off` disables both persistence and re-declaration, so the
 * previous behaviour can be restored without editing config or code.
 */
const FILE_NAME = 'cache-state.json';

function stabilityEnabled(): boolean {
  return String(process.env.BIOFLOW_TOOL_SET_STABILITY || '').trim().toLowerCase() !== 'off';
}

function filePath(conversationId: string): string | null {
  if (!conversationId) return null;
  const projectKey = findSessionProjectKey(conversationId);
  if (!projectKey) return null;
  return path.join(sessionDirectory(projectKey, conversationId), FILE_NAME);
}

/**
 * Tool names this conversation has activated, in the order they were first installed.
 *
 * Returns an empty list for an unknown conversation or an unreadable file: a missing record
 * means "nothing was ever installed", and failing the run over a corrupt bookkeeping file
 * would be worse than starting from the resident set.
 */
export function readActivatedToolNames(conversationId: string): string[] {
  if (!stabilityEnabled()) return [];
  const file = filePath(conversationId);
  if (!file || !fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { tools?: unknown };
    if (!Array.isArray(parsed.tools)) return [];
    return parsed.tools.filter((name): name is string => typeof name === 'string' && name.length > 0);
  } catch {
    return [];
  }
}

/**
 * Append newly activated tool names, preserving first-activation order.
 *
 * Existing names are never re-ordered or removed: the array is meant to be monotonic, and
 * a reorder would invalidate the prefix just as surely as a removal.
 */
export function recordActivatedToolNames(conversationId: string, names: readonly string[]): void {
  if (!stabilityEnabled() || !names.length) return;
  const file = filePath(conversationId);
  if (!file) return;
  const existing = readActivatedToolNames(conversationId);
  const seen = new Set(existing);
  const merged = [...existing];
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  if (merged.length === existing.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ tools: merged, ...(readSystemPromptHash(conversationId) ? { systemPromptHash: readSystemPromptHash(conversationId) } : {}) }, null, 2)}\n`,
  );
  fs.renameSync(tmp, file);
}

/** Drop the record — used by tests and by anything that resets a conversation's capabilities. */
export function clearActivatedToolNames(conversationId: string): void {
  const file = filePath(conversationId);
  if (!file) return;
  fs.rmSync(file, { force: true });
}

/**
 * Fingerprint of the system prompt the conversation last assembled (`messages[0]`).
 *
 * The prompt is rebuilt from disk on every run, so an edit to a prompt file, an agent
 * profile or the curated tool-library index changes the first token of every request from
 * that moment on — for every conversation, silently. Recording the hash per conversation
 * is what turns "the cache stopped hitting this afternoon" into "the prompt changed at
 * run N"; without it the only evidence is a hash nobody diffed.
 */
export function readSystemPromptHash(conversationId: string): string | null {
  if (!stabilityEnabled()) return null;
  const file = filePath(conversationId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { systemPromptHash?: unknown };
    return typeof parsed.systemPromptHash === 'string' && parsed.systemPromptHash ? parsed.systemPromptHash : null;
  } catch {
    return null;
  }
}

/** Remember the hash of the system prompt this run assembled. */
export function recordSystemPromptHash(conversationId: string, hash: string): void {
  if (!stabilityEnabled() || !hash) return;
  const file = filePath(conversationId);
  if (!file) return;
  const existing = readSystemPromptHash(conversationId);
  if (existing === hash) return;
  const tools = readActivatedToolNames(conversationId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ tools, systemPromptHash: hash }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
