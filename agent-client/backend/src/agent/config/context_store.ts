import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type { Message } from './conversation_types.js';
import { listRecords, readRecord, updateRecord } from './conversation_file_store.js';
import { readProjectFile } from './project_files.js';
import { resolveTranscriptBlobPath } from '../transcript_reader.js';

export interface ContextCheckpoint {
  id: string;
  conversationId: string;
  runId: string | null;
  schemaVersion: number;
  triggerReason: string;
  tokenEstimate: number;
  watermarkRatio: number;
  pinnedFingerprint: string;
  programState: unknown;
  modelSummary: unknown;
  createdAt: string;
}

export type HistoryLookupType =
  | 'user_prompt'
  | 'assistant_text'
  | 'assistant_tool_call'
  | 'tool_result'
  | 'system_event'
  | 'summary_checkpoint';

export interface HistoryLookupOptions {
  query?: string;
  types?: HistoryLookupType[];
  limit?: number;
  includeFullContent?: boolean;
}

export interface HistoryLookupItem {
  type: HistoryLookupType;
  id: string;
  createdAt: string;
  preview: string;
  content?: unknown;
}

export function createContextCheckpoint(data: {
  conversationId: string;
  runId?: string | null;
  triggerReason: string;
  tokenEstimate: number;
  watermarkRatio: number;
  pinnedFingerprint?: string;
  programState: unknown;
  modelSummary: unknown;
}): ContextCheckpoint {
  const id = uuidv4();
  const checkpoint: ContextCheckpoint = { id, conversationId: data.conversationId, runId: data.runId || null, schemaVersion: 1, triggerReason: data.triggerReason, tokenEstimate: data.tokenEstimate, watermarkRatio: data.watermarkRatio, pinnedFingerprint: data.pinnedFingerprint || '', programState: data.programState || {}, modelSummary: data.modelSummary || {}, createdAt: new Date().toISOString() };
  const result = updateRecord(data.conversationId, (record) => { record.checkpoints.push(checkpoint); return checkpoint; }, () => ({ type: 'patch', collections: { checkpoints: { upserts: [checkpoint], deletes: [] } } }));
  if (!result) throw new Error('Conversation not found.');
  return result;
}

export function getLatestContextCheckpoint(conversationId: string): ContextCheckpoint | null {
  const checkpoints = readRecord(conversationId)?.checkpoints || [];
  const checkpoint = [...checkpoints].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  return checkpoint || null;
}

export function getContextCheckpoint(id: string): ContextCheckpoint | null {
  for (const record of listRecords()) { const checkpoint = record.checkpoints.find((item) => String(item.id) === id); if (checkpoint) return checkpoint; }
  return null;
}

export function lookupConversationHistory(
  conversationId: string,
  messages: Message[],
  options: HistoryLookupOptions = {},
): HistoryLookupItem[] {
  const allowed = new Set<HistoryLookupType>(options.types?.length ? options.types : [
    'user_prompt',
    'assistant_text',
    'assistant_tool_call',
    'tool_result',
    'system_event',
    'summary_checkpoint',
  ]);
  const query = (options.query || '').trim().toLowerCase();
  const includeFullContent = Boolean(options.includeFullContent);
  const limit = Math.max(1, Math.min(options.limit || 10, 50));
  const items: HistoryLookupItem[] = [];

  for (const message of messages) {
    if (message.role === 'user' && allowed.has('user_prompt')) {
      pushIfMatches(items, query, {
        type: 'user_prompt',
        id: message.id,
        createdAt: message.createdAt,
        preview: previewText(message.content),
        ...(includeFullContent ? { content: message.content } : {}),
      }, message.content);
    }

    if (message.role === 'assistant' && message.content && allowed.has('assistant_text')) {
      pushIfMatches(items, query, {
        type: 'assistant_text',
        id: message.id,
        createdAt: message.createdAt,
        preview: previewText(message.content),
        ...(includeFullContent ? { content: message.content } : {}),
      }, message.content);
    }

    const events = Array.isArray(message.toolCalls?.run?.events) ? message.toolCalls.run.events : [];
    for (const event of events) {
      const eventType = typeof event?.type === 'string' ? event.type : 'event';
      if (event.type === 'tool_call_start' && allowed.has('assistant_tool_call')) {
        pushIfMatches(items, query, {
          type: 'assistant_tool_call',
          id: `${message.id}:${items.length}`,
          createdAt: message.createdAt,
          preview: `${event.tool_name || 'tool'} ${previewText(JSON.stringify(event.arguments || {}), 600)}`,
          ...(includeFullContent ? { content: event } : {}),
        }, JSON.stringify(event.arguments || {}));
      } else if (event.type === 'tool_call_result' && allowed.has('tool_result')) {
        const fullContent = readToolResultContent(conversationId, event);
        pushIfMatches(items, query, {
          type: 'tool_result',
          id: `${message.id}:${items.length}`,
          createdAt: message.createdAt,
          preview: `${event.tool_name || 'tool'} => ${previewText(event.result || JSON.stringify(event.observation || {}), 900)}`,
          ...(includeFullContent ? { content: fullContent || event } : {}),
        }, fullContent || event.result || JSON.stringify(event.observation || {}));
      } else if (isSystemEvent(eventType) && allowed.has('system_event')) {
        pushIfMatches(items, query, {
          type: 'system_event',
          id: `${message.id}:${items.length}`,
          createdAt: message.createdAt,
          preview: `${eventType}: ${previewText(getEventDetail(event), 900)}`,
          ...(includeFullContent ? { content: event } : {}),
        }, event);
      }
    }
  }

  if (allowed.has('summary_checkpoint')) {
    const rows = (readRecord(conversationId)?.checkpoints || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20);
    for (const row of rows) {
      const checkpoint = row;
      pushIfMatches(items, query, {
        type: 'summary_checkpoint',
        id: checkpoint.id,
        createdAt: checkpoint.createdAt,
        preview: previewText(JSON.stringify(checkpoint.modelSummary)),
        ...(includeFullContent ? { content: checkpoint } : {}),
      }, checkpoint);
    }
  }

  return items
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-limit);
}

function isSystemEvent(eventType: string): boolean {
  return [
    'info',
    'loop_health',
    'mcp_status',
    'workspace_artifact',
    'planning_panel',
    'security_approval_request',
    'security_approval_result',
    'error',
  ].includes(eventType);
}

function getEventDetail(event: { type: string }): unknown {
  if ('content' in event) return event.content;
  if ('detail' in event) return event.detail;
  if ('error' in event) return event.error;
  return event;
}

/**
 * Keeps an item when every word of the query appears somewhere in it.
 *
 * The whole query used to be matched as one literal substring, which made the tool nearly
 * useless for the case it exists for: searching "表达量" could not find a line that says
 * "表达量矩阵", and a two-word query could only match that exact two-word sequence. Words are
 * now ANDed independently, which is what a reader means by a search.
 */
function pushIfMatches(items: HistoryLookupItem[], query: string, item: HistoryLookupItem, searchableContent?: unknown): void {
  const haystack = `${item.preview} ${typeof searchableContent === 'string' ? searchableContent : JSON.stringify(searchableContent || item.content || '')}`.toLowerCase();
  if (matchesAllTerms(haystack, query)) items.push(item);
}

function matchesAllTerms(haystack: string, query: string): boolean {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  return terms.every((term) => haystack.includes(term));
}

function readToolResultContent(conversationId: string, event: any): string | null {
  // Preferred source: the content-addressed blob the transcript wrote for this result.
  // It is exact, present for every recorded run, and lives inside the conversation's own
  // storage — so recovering it involves no project-boundary read and no approval prompt.
  const blobRef = event?.rawResult;
  if (typeof blobRef === 'string') {
    try {
      return fs.readFileSync(resolveTranscriptBlobPath(conversationId, blobRef), 'utf8');
    } catch {
      // Fall through: an unreadable blob must not cost the caller the event preview too.
    }
  }

  // Legacy source: results that were registered as workspace artifacts. The observation
  // pipeline no longer does that (they live in the session directory), but transcripts
  // recorded before that change still point here.
  const artifactPath = event?.observation?.artifact?.path;
  if (!artifactPath || typeof artifactPath !== 'string') return null;
  try {
    const projectPath = readRecord(conversationId)?.conversation.projectPath;
    if (!projectPath) return null;
    const file = readProjectFile(projectPath, artifactPath);
    return file.encoding === 'utf8' ? file.content : null;
  } catch {
    return null;
  }
}

function previewText(value: unknown, maxLength = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[truncated]` : text;
}
