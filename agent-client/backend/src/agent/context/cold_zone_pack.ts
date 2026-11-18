import type { ColdZoneGroup, TokenEstimator } from './cold_zone.js';
import { extractEvidenceLines, fidelityScore, messageText } from './cold_zone.js';

/** Metadata a tool result carries into the cold zone, indexed by tool-call id. */
export interface ToolResultMeta {
  toolName: string;
  argsPreview: string;
  outcome: 'ok' | 'error' | 'unknown';
  producedFiles: string[];
  blobRef?: string;
}

/** The shape the runtime holds: a chat-completion message. */
export interface ChatLikeMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

export interface PackChatOptions {
  meta?: Map<string, ToolResultMeta>;
  estimateTokens: TokenEstimator;
  estimateMessage: (message: ChatLikeMessage) => number;
}

/**
 * Group chat messages into cold-zone candidates.
 *
 * A tool result belongs to the assistant message that requested it: they are kept,
 * degraded and summarised as one unit. An orphan result (a conversation recorded before
 * the runtime kept `tool_calls`, or a call whose owner fell outside the slice) becomes its
 * own group, so it can still be lowered or archived without inventing a pairing.
 */
export function packChatMessages(messages: readonly ChatLikeMessage[], options: PackChatOptions): ColdZoneGroup<ChatLikeMessage>[] {
  const groups: ColdZoneGroup<ChatLikeMessage>[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      groups.push(buildGroup(groups.length, message, 'user', [message], options));
      continue;
    }

    if (message.role === 'assistant') {
      const owned = new Set<string>();
      for (const call of message.tool_calls || []) {
        if (call?.id) owned.add(String(call.id));
      }
      const collected: ChatLikeMessage[] = [message];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor].role === 'tool') {
        const result = messages[cursor];
        collected.push(result);
        cursor += 1;
      }
      index = cursor - 1;
      groups.push(buildGroup(groups.length, message, 'assistant', collected, options, owned));
      continue;
    }

    groups.push(buildGroup(groups.length, message, 'tool-orphan', [message], options));
  }
  return groups;
}

function buildGroup(
  seq: number,
  head: ChatLikeMessage,
  kind: 'user' | 'assistant' | 'tool-orphan',
  messages: ChatLikeMessage[],
  options: PackChatOptions,
  ownedCalls?: Set<string>,
): ColdZoneGroup<ChatLikeMessage> {
  const toolNames: string[] = [];
  const argsPreviewParts: string[] = [];
  const producedFiles: string[] = [];
  const blobRefs: string[] = [];
  let outcome: 'ok' | 'error' | 'unknown' = 'unknown';

  for (const call of head.tool_calls || []) {
    const name = call?.function?.name;
    if (name) toolNames.push(String(name));
    const args = call?.function?.arguments;
    if (args) argsPreviewParts.push(String(args));
    const meta = call?.id ? options.meta?.get(String(call.id)) : undefined;
    // A call with no recorded result yet is not a failure; it is unknown on purpose.
    if (meta) {
      if (meta.outcome === 'error') outcome = 'error';
      else if (outcome !== 'error') outcome = 'ok';
      for (const file of meta.producedFiles) producedFiles.push(file);
      if (meta.blobRef) blobRefs.push(meta.blobRef);
    }
  }
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const meta = message.tool_call_id ? options.meta?.get(String(message.tool_call_id)) : undefined;
    if (meta?.toolName && !toolNames.includes(meta.toolName)) toolNames.push(meta.toolName);
    if (meta?.argsPreview) argsPreviewParts.push(meta.argsPreview);
    if (meta) {
      if (meta.outcome === 'error') outcome = 'error';
      else if (outcome !== 'error' && meta.outcome === 'ok') outcome = 'ok';
      for (const file of meta.producedFiles) producedFiles.push(file);
      if (meta.blobRef) blobRefs.push(meta.blobRef);
    }
    if (ownedCalls && message.tool_call_id && !ownedCalls.has(String(message.tool_call_id))) {
      // Recorded defensively: the group still owns the message, but the mismatch is worth
      // knowing about when a transcript is inspected.
      outcome = outcome === 'error' ? 'error' : 'unknown';
    }
  }

  const text = messages.map((message) => messageText(message.content)).filter(Boolean).join('\n');
  const sizeTokens = messages.reduce((total, message) => total + options.estimateMessage(message), 0);
  return finaliseGroup({
    seq,
    kind,
    messages,
    text,
    sizeTokens,
    toolNames,
    argsPreview: argsPreviewParts.join(' '),
    outcome,
    producedFiles: unique(producedFiles),
    blobRefs: unique(blobRefs),
  }, options.estimateTokens);
}

/** A stored conversation message: `role` + `content`, with the run's events attached. */
export interface StoredLikeMessage {
  role: string;
  content: string;
  toolCalls?: {
    run?: {
      events?: Array<Record<string, unknown>>;
    };
  } | null;
}

export interface PackStoredOptions {
  estimateTokens: TokenEstimator;
}

/**
 * Group stored messages for the run-end checkpoint.
 *
 * Stored conversations do not keep `tool` messages: a run's tool calls and results live on
 * the assistant message as events. The group is therefore one message, and its metadata is
 * read back out of those events.
 */
export function packStoredMessages(messages: readonly StoredLikeMessage[], options: PackStoredOptions): ColdZoneGroup<StoredLikeMessage>[] {
  const groups: ColdZoneGroup<StoredLikeMessage>[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue;
    const kind = message.role === 'user' ? 'user' : 'assistant';
    const toolNames: string[] = [];
    const args: string[] = [];
    const producedFiles: string[] = [];
    const blobRefs: string[] = [];
    let outcome: 'ok' | 'error' | 'unknown' = 'unknown';
    let eventText = '';

    for (const event of message.toolCalls?.run?.events || []) {
      if (event?.type === 'tool_call_start') {
        const name = String(event.tool_name || '');
        if (name && !toolNames.includes(name)) toolNames.push(name);
        const rawArgs = typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments || '');
        if (rawArgs && rawArgs !== '{}') args.push(rawArgs);
      } else if (event?.type === 'tool_call_result') {
        const name = String(event.tool_name || '');
        if (name && !toolNames.includes(name)) toolNames.push(name);
        const files = Array.isArray(event.producedFiles) ? event.producedFiles.map(String) : [];
        for (const file of files) producedFiles.push(file);
        const blob = typeof event.rawResult === 'string' ? event.rawResult : '';
        if (blob) blobRefs.push(blob);
        const isError = event.isError === true;
        if (isError) outcome = 'error';
        else if (outcome !== 'error') outcome = 'ok';
        const detail = typeof event.result === 'string' ? event.result : '';
        if (detail) eventText += `\n${detail}`;
      }
    }

    const text = [message.content, eventText].filter(Boolean).join('\n');
    const sizeTokens = options.estimateTokens(message.content);
    groups.push(finaliseGroup({
      seq: groups.length,
      kind,
      messages: [message],
      text,
      sizeTokens,
      toolNames,
      argsPreview: args.join(' '),
      outcome,
      producedFiles: unique(producedFiles),
      blobRefs: unique(blobRefs),
    }, options.estimateTokens));
  }
  return groups;
}

function finaliseGroup<T>(
  group: Omit<ColdZoneGroup<T>, 'evidenceLines' | 'fidelity' | 'summaryText' | 'score'>,
  estimateTokens: TokenEstimator,
): ColdZoneGroup<T> {
  const evidenceLines = group.kind === 'user' ? [] : extractEvidenceLines(group.text);
  return {
    ...group,
    evidenceLines,
    fidelity: fidelityScore(group.text),
    summaryText: buildSummaryText(group, evidenceLines),
    score: 0,
  };
}

/**
 * What the summariser sees for one group.
 *
 * Not the raw body: a tool result's payload is archived, and re-sending it to the
 * summariser would make the source as large as the history it is replacing. What matters
 * for a summary is what ran, how it ended, what it produced, and the few exact strings.
 */
function buildSummaryText<T>(
  group: Omit<ColdZoneGroup<T>, 'evidenceLines' | 'fidelity' | 'score' | 'summaryText'>,
  evidenceLines: string[],
): string {
  if (group.kind === 'user') return messagePreview(group.text, 600);
  const parts: string[] = [];
  if (group.toolNames.length) parts.push(`tools: ${group.toolNames.join(', ')}`);
  if (group.argsPreview) parts.push(`args: ${messagePreview(group.argsPreview, 240)}`);
  if (group.producedFiles.length) parts.push(`files: ${group.producedFiles.slice(0, 4).join(', ')}`);
  parts.push(`outcome: ${group.outcome}`);
  if (evidenceLines.length) parts.push(`evidence: ${evidenceLines.join(' | ')}`);
  const prose = evidenceLines.length ? '' : messagePreview(group.text, 400);
  return [parts.join('; '), prose].filter(Boolean).join('\n');
}

function messagePreview(text: string, limit: number): string {
  const normalised = text.replace(/\s+/g, ' ').trim();
  return normalised.length > limit ? `${normalised.slice(0, limit)}…` : normalised;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
