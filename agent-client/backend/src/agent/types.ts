import type { AgentProfile } from './config/agent_config_store.js';
import type { CacheMode, CacheReportMode, LLMProtocol } from './config/llm_config_store.js';
import type { MCPServer } from './config/mcp_config_store.js';
import type { Skill } from './config/skill_config_store.js';
import type { CommandRisk, SecurityMode } from './security_policy.js';
import type { TranscriptRecorder } from './transcript_store.js';
import type { GoalOperation, GoalSnapshot, TodoStatus } from './conversation_panels.js';

/**
 * How the provider reaches its thinking budget. Only the request body differs, so
 * every value runs on the same OpenAI-compatible transport.
 *
 * - `openai-effort`:    `{"reasoning_effort": <wire>}`
 * - `anthropic-budget`: `{"thinking": {"type": "enabled", "budget_tokens": <wire>}}`
 * - `none`:             nothing is sent
 */
export type LLMThinkingFormat = 'openai-effort' | 'anthropic-budget' | 'none';

export interface LLMThinking {
  format: LLMThinkingFormat;
  /** The spelling this endpoint accepts; a number only for a token budget. */
  wire: string | number;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  /** Static request headers the provider requires (e.g. OpenCode routing headers). */
  headers?: Record<string, string>;
  model: string;
  contextWindowTokens?: number;
  /**
   * Resolved thinking setting. Preferred over `thinkingLevel`, which is kept for
   * callers written before the level-name/wire-value split.
   */
  thinking?: LLMThinking;
  /**
   * @deprecated Sent as OpenAI-compatible `reasoning_effort` exactly as supplied.
   * Use `thinking` so the level name and the wire value can differ.
   */
  thinkingLevel?: string;
  /**
   * Whether an absent prefix-cache counter means "unknown" (`none`/`full`) or "a miss"
   * (`hits-only`). See `CacheReportMode` in `config/llm_config_store`.
   */
  cacheReport?: CacheReportMode;
  /** `explicit` when the endpoint needs `cache_control` breakpoints to cache anything. */
  cacheMode?: CacheMode;
  /**
   * Wire protocol; omitted means `openai-completions`. The runtime keeps one
   * OpenAI-shaped message model and normalizes at this boundary.
   */
  protocol?: LLMProtocol;
}

/**
 * One attributable block of the assembled system prompt.
 *
 * `start`/`end` are offsets into the exact string that was sent as `messages[0]`. That is
 * what lets the transcript answer "where did this text come from" without storing the
 * prompt a second time: the reader slices the recorded request with these offsets.
 *
 * `source` names the origin — a config file path for the agent's own prompt, a stable label
 * for the generated catalogs. It is recorded at assembly time on purpose: the config files
 * behind it are re-read uncached on every run, so matching text against them later would
 * attribute today's file to yesterday's request.
 */
export interface SystemPromptSection {
  kind: 'agent-prompt' | 'agent-guidance' | 'team' | 'core-tools' | 'tool-library' | 'cli-tools' | 'workspace';
  source: string;
  start: number;
  end: number;
}

/** Where the assembled prompt came from, without a second copy of its text. */
export interface SystemPromptProvenance {
  sha256: string;
  sections: SystemPromptSection[];
}

/** The prompt as it is read back: provenance plus the verbatim text from the request. */
export interface RecordedSystemPrompt extends SystemPromptProvenance {
  text: string;
}

/** One model-visible tool call, in the shape the runtime replays. */
export interface AgentChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** One model-visible history row, replayed verbatim into the next request. */
export interface AgentChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  toolCalls?: AgentChatToolCall[] | null;
  toolCallId?: string | null;
}

/** One message the runtime produced, reported so the caller can persist it. */
export interface AgentContextMessage {
  role: 'assistant' | 'tool';
  content: unknown;
  toolCalls?: AgentChatToolCall[] | null;
  toolCallId?: string | null;
  toolName?: string | null;
}

export interface AgentChatRequest {
  runId?: string | null;
  llm: LLMConfig;
  messages: AgentChatMessage[];
  userMessage: string;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
  /** Provenance for `systemPrompt`, recorded so the prompt can be attributed on read. */
  systemPromptSections?: SystemPromptSection[];
  /**
   * Per-run volatile blocks (current date, recent artifacts), appended as user messages
   * just before `userMessage`. They must not go into `systemPrompt`: a prefix cache only
   * matches from token 0, so changing `messages[0]` would invalidate the whole history.
   */
  pinnedTail?: string[];
  conversationId?: string;
  mainAgent?: AgentProfile;
  /** Agent profile that answers this run; recorded in the transcript's `run_start`. */
  agentId?: string;
  /** Team role of the conversation, when it is a role session. */
  roleId?: string | null;
  /** Conversation that spawned this one; null for a user-started conversation. */
  parentConversationId?: string | null;
  /** Run that spawned this one; null for a user-started run. */
  parentRunId?: string | null;
  mcpServers: MCPServer[];
  skills?: Pick<Skill, 'id' | 'name' | 'description' | 'instructions' | 'resources'>[];
  securityMode?: SecurityMode;
  /**
   * Delegation depth this run executes at: 0 for a user-started run, parent+1 for a
   * delegated child. Tools read it through `CoreToolExecutionContext`; it is never taken
   * from tool arguments, so a child cannot claim a smaller depth than it was given.
   */
  delegationDepth?: number;
  /**
   * How a tool call that needs confirmation is handled.
   *
   * `ask` (default) surfaces an approval request to the client. `never` — used by
   * delegated children, whose conversation has no approval UI — refuses such a call with
   * a stable error instead of waiting for a decision nobody can make.
   */
  approvalPolicy?: 'ask' | 'never';
  /**
   * Receives this run's transcript handle once it exists, so the caller can mirror
   * engine events it raises outside the runtime (run context, budget, cancellation)
   * into the same log. Called with `null` when the run has no conversation to record
   * against.
   */
  onTranscript?: (recorder: TranscriptRecorder | null) => void;
  /**
   * Live context state for this run, reported by the runtime.
   *
   * The service assembles the first request but does not see the array the runtime keeps
   * growing, so it cannot otherwise know how full the context is when the run ends. The
   * runtime reports the budget every turn and at run end, and attaches the structured
   * summary whenever it compacted mid-run — which is what lets the run-end checkpoint
   * reuse that summary instead of summarising the same history again.
   */
  onRuntimeContext?: (update: RuntimeContextUpdate) => void;
  /**
   * One model-visible message as this run produces it, so the caller can append it to
   * the conversation's model transcript.
   *
   * The runtime owns the only complete array: the service assembles the first request
   * but never sees the assistant tool calls and tool rows a run appends. Reporting them
   * here is what lets the next run replay the same context instead of dropping it.
   */
  onContextMessage?: (message: AgentContextMessage) => void;
  /**
   * Checkpoint from a previous run, used as the starting point when this run compacts.
   *
   * Deliberately a field rather than a message: the request already carries the full
   * history, so a summary injected alongside it would pay for the same content twice.
   */
  priorCheckpoint?: { programState: unknown; modelSummary: unknown } | null;
}

/** The subset of the budget the service needs; kept structural to avoid a module cycle. */
export interface RuntimeContextBudgetSnapshot {
  tokenEstimate: number;
  contextLimit: number;
  contextWindowTokens: number;
  ratio: number;
  softExceeded: boolean;
  hardExceeded: boolean;
}

export interface RuntimeContextUpdate {
  budget: RuntimeContextBudgetSnapshot;
  /** Present only when this update follows a successful in-run compaction. */
  summary?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: 'run_status'; runId: string | null; status: string; stopReason?: string | null }
  | {
      type: 'loop_health'; level: 'info' | 'warning'; reason: string; detail: string; toolName?: string; discardedContentChars?: number;
      tokenUsage?: { promptTokens: number; completionTokens: number | null; totalTokens: number | null; heuristicPromptTokens: number; calibrationMultiplier: number; cachedPromptTokens?: number | null };
    }
  | { type: 'content'; content: string }
  /**
   * The model's reasoning for the current turn. Streamed to the UI and rebuilt from the
   * transcript's raw provider chunks on read; deliberately never part of the message
   * content, so it is not re-sent to the provider on the next request.
   */
  | { type: 'thinking'; content: string }
  | { type: 'plan_update'; title: string; steps: string[] }
  | {
      type: 'planning_panel';
      panel: 'clarify' | 'plan' | 'todo';
      status: 'waiting' | 'active' | 'complete';
      title: string;
      questions?: Array<{ id: string; question: string; options: string[] }>;
      markdown?: string;
      filePath?: string;
      /**
       * The complete to-do list as it stands after this write. `done` is the legacy
       * spelling still found in older transcripts; writers now emit `status`.
       */
      todos?: Array<{ id: string; text: string; status: TodoStatus; done?: boolean }>;
      note?: string;
    }
  /**
   * The complete durable goal document, or `null` for a clear tombstone.
   *
   * State documents rather than deltas: the fold is last-write-wins, so a reader that
   * only sees the tail reconstructs the same goal a full replay would.
   */
  | { type: 'goal_change'; operation: GoalOperation; goal: GoalSnapshot | null }
  /** One admitted automatic continuation round; counted, never rewritten. */
  | { type: 'goal_round'; goalId: string; revision: number; round: number }
  | {
      type: 'security_approval_request';
      approvalId: string;
      runId: string | null;
      toolName: string;
      arguments: Record<string, unknown>;
      mode: SecurityMode;
      risk: CommandRisk;
      reason: string;
    }
  | { type: 'security_approval_result'; approvalId: string; decision: 'approve' | 'deny' }
  | { type: 'workspace_artifact'; artifact: { id: string; title: string; path: string; type: string } }
  | { type: 'tool_call_start'; tool_name: string; arguments: Record<string, unknown>; turnIndex?: number; planStepIndex?: number | null }
  | {
      type: 'tool_call_result';
      tool_name: string;
      result: string;
      /**
       * Blob reference (`blobs/sha256-….txt`) of the exact raw result, present on rebuilt
       * events only. It lets trace readers recover bytes that are deliberately kept out
       * of the event stream; it is a reference, never the content.
       */
      rawResult?: string;
      observation?: Record<string, unknown>;
      turnIndex?: number;
      planStepIndex?: number | null;
    }
  | {
      type: 'mcp_status';
      connected: Array<{ name: string; tools_count: number; prompts_count: number; resources_count: number }>;
      failed: Array<{ name: string; error: string }>;
      disconnected: string[];
    }
  | { type: 'error'; error: string }
  | { type: 'done' };

export interface MCPServerConfig {
  name: string;
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transportType?: 'stdio' | 'sse' | 'streamableHttp';
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments: Array<{ name: string; description?: string; required: boolean }>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * One resource exposed by an MCP server, as the runtime catalog sees it. Shaped
 * like {@link MCPResource} plus the owning server so catalogs can be flattened.
 */
export interface CatalogResourceEntry {
  kind: 'mcp_resource';
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** One MCP tool in the runtime catalog. `id` is the public `<server>__<tool>` name. */
export interface CatalogToolEntry {
  kind: 'mcp_tool';
  id: string;
  server: string;
  /** Raw MCP tool name, as sent on the wire. */
  toolName: string;
  description: string;
}

/** One connected MCP server: instructions plus the tools and resources it exposes. */
export interface CatalogServerEntry {
  name: string;
  /** Server instructions from `initialize`; empty string when the server sent none. */
  instructions: string;
  tools: CatalogToolEntry[];
  resources: CatalogResourceEntry[];
}

export interface MCPConnectResult {
  tools: unknown[];
  serverCatalog: CatalogServerEntry[];
  connected: Array<{ name: string; tools_count: number; prompts_count: number; resources_count: number }>;
  failed: Array<{ name: string; error: string }>;
  disconnected: string[];
}
