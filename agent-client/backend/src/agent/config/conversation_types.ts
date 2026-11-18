export interface Conversation {
  id: string;
  title: string;
  pinned: boolean;
  skillId: string | null;
  promptId: string | null;
  llmProviderId: string | null;
  /**
   * Absolute real path of the project directory this session works in. This is
   * the session's working root; membership in a project is derived from it, so
   * there is deliberately no separate project id to drift out of sync.
   */
  projectPath: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when this conversation was created as a delegated subagent.
   *
   * The child keeps its own transcript and runs; the pointer is what makes it
   * discoverable from the parent (`subagent action=status`) without a second store.
   */
  parentConversationId?: string | null;
  /** Delegation depth the child was created at (root user runs are depth 0). */
  subagentDepth?: number | null;
  /** Short label supplied when the delegation started. */
  subagentDescription?: string | null;
  /**
   * Role that created this delegated subagent, recorded at creation.
   *
   * The child runs with that role's profile. Remembering it on the conversation keeps the
   * identity after the run that started it is gone: continuing the child later answers as
   * the same role instead of falling back to whoever the caller happened to select.
   */
  agentId?: string | null;
  /**
   * Set when this conversation is the team session of one role.
   *
   * A team consists of a root conversation plus one child conversation per role, all of
   * them sharing the root's project directory. `roleId` is what tells a role session and a
   * delegated subagent apart: both are children of another conversation, but only a role
   * session belongs to the team's merged timeline.
   */
  roleId?: string | null;
}

export interface StoredRunState {
  plan: unknown;
  /**
   * Identifies the run this message belongs to. Optional because records written
   * before the transcript became the single source carry neither this nor a live
   * `events` array.
   */
  runId?: string | null;
  /**
   * This run's runtime events.
   *
   * **Not persisted.** `persist()` deliberately omits them — they live in the session
   * transcript — and the store re-attaches them on read. The field stays on the type
   * because every consumer already reads the message shape (context assembly derives
   * loaded tools and skills from these events; the Web renders the trace from them),
   * and keeping one shape is what stops a second stored copy creeping back in.
   */
  events?: AgentEvent[];
  /**
   * The system prompt this run sent, with its provenance.
   *
   * **Not persisted** — like `events`, it is rebuilt from the transcript when the message
   * is read. It lives on the run so the Web can attribute the prompt the model actually
   * saw without fetching the whole request.
   */
  systemPrompt?: RecordedSystemPrompt;
  summary: string;
  startedAt: string;
  status: 'running' | 'completed' | 'error';
  completedAt?: string;
  interruptedAt?: string;
  error?: string;
}

export interface MessageToolCalls {
  run?: StoredRunState;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: MessageToolCalls | null;
  createdAt: string;
}
import type { AgentEvent, RecordedSystemPrompt } from '../types.js';

/** One model-visible tool call; `arguments` is the raw JSON string the model emitted. */
export interface ContextToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * One model-visible message of the conversation transcript.
 *
 * Append-only: assembly replays these rows and never rewrites history, and compaction is
 * a projection over them. Kept apart from `Message` because the granularity differs —
 * `messages` is the chat record (one aggregated assistant bubble per run, with run
 * metadata), while this is exactly what the model saw: one row per model step plus one
 * row per tool result.
 */
export interface ContextMessage {
  id: string;
  conversationId: string;
  runId: string | null;
  /** Monotonic within the conversation; assembly sorts by it. */
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  toolCalls: ContextToolCall[] | null;
  toolCallId: string | null;
  toolName: string | null;
  createdAt: string;
}
