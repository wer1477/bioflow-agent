import type { AgentChatMessage, AgentContextMessage, LLMConfig, SystemPromptSection } from '../types.js';
import { buildCoreToolsCatalogPrompt, TOOLLIBRARY_CORE_TOOL_ID } from '../core_tools_runtime.js';
import { TEAM_MESSAGE_CORE_TOOL_ID } from '../core_tools/ids.js';
import {
  capabilitySelectionModes,
  residentCoreToolIds,
  type CapabilityCoreToolId,
  type CapabilitySelectionMode,
} from '../core_tools/capability_selection.js';
import { renderTeamPrompt } from '../team/team_prompt.js';
import { renderCliCapabilitiesPrompt, renderToolLibraryDomainIndexPrompt, type ToolLibraryPromptVisibility } from '../core_tools/toollibrary_executor.js';
import { TOOLLIBRARY_ROOT } from '../../paths.js';
import * as agentConfigStore from '../config/agent_config_store.js';
import * as conversationService from '../config/conversation_service.js';
import { getConversationArtifacts } from '../config/workspace_artifact_store.js';
import * as llmConfigStore from '../config/llm_config_store.js';
import { readSessionLlmOverride } from '../config/session_llm_override_store.js';
import { resolveLLMTargetForCurrentUser, resolveRoleBinding } from '../../auth/user_llm_store.js';
import { interpolateEnvironment } from '../config/secret_config.js';
import * as mcpConfigStore from '../config/mcp_config_store.js';
import * as skillConfigStore from '../config/skill_config_store.js';
import type {
  AgentProfile,
  CoreTool,
} from '../config/agent_config_store.js';
import type { ProjectWorkspaceSummary } from '../config/project_files.js';
import type { ContextMessage, Message } from '../config/conversation_types.js';
import * as contextMessageStore from '../config/context_message_store.js';
import type { LLMProvider } from '../config/llm_config_store.js';
import type { MCPServer } from '../config/mcp_config_store.js';
import type { Skill } from '../config/skill_config_store.js';

export interface AgentContextRequest {
  conversationId?: string;
  agentId?: string;
  llmProviderId?: string;
  /** Delegation depth of this run; a delegated child (>= 1) loses the dispatch authority. */
  delegationDepth?: number;
}

export interface AgentRuntimeContext {
  agent: AgentProfile;
  llmProvider: LLMProvider;
  llm: LLMConfig;
  coreTools: CoreTool[];
  mcpServers: MCPServer[];
  skills: Skill[];
  workspace: ProjectWorkspaceSummary | null;
  systemPrompt: string;
  /** Where each block of `systemPrompt` came from, as offsets into it. */
  systemPromptSections: SystemPromptSection[];
  /**
   * Blocks that legitimately change between runs.
   *
   * They are kept OUT of `systemPrompt` on purpose: a provider prefix cache matches from
   * token 0 only, so any volatile byte inside `messages[0]` invalidates the whole history
   * behind it. Appended immediately before the user message, the same content costs one
   * short prefill instead, and everything before it stays reusable.
   */
  pinnedTail: string[];
  info: string;
}

export class AgentContextResolver {
  resolve(request: AgentContextRequest): AgentRuntimeContext {
    const agent = this.resolveChatAgent(request.agentId);
    if (!agent) {
      throw new AgentContextError(400, 'Selected agent is missing.');
    }

    // A delegated child inherits the creating role's profile, but not the team lead's
    // authority: `dispatch` hands work to role sessions that only the lead's team run drains,
    // so a child holding it could queue a dispatch nobody consumes. Strip it before the
    // profile is used for anything, so the tool schema list and the prompt catalog agree.
    const runtimeAgent = withDelegationAuthority(agent, request.delegationDepth ?? 0);
    const coreTools = this.resolveCoreTools(runtimeAgent);
    // Resolution order: the session override for this role > the user's own role binding >
    // the role's binding in agents.json > the global default. The session override is what
    // the composer's model picker writes; the user binding is stored per role and only
    // overrides provider/model/thinking, never the role definition itself.
    //
    // The override is one complete selection, so it replaces all three fields instead of
    // joining them field by field: a per-field `||` chain can pair the picker's model with
    // another layer's provider and fail resolution with a model that "does not exist".
    const sessionOverride = readSessionLlmOverride(request.conversationId, runtimeAgent.role);
    const roleBinding = sessionOverride ? null : resolveRoleBinding(runtimeAgent.role);
    const llmProvider = this.resolveLlmProvider(sessionOverride
      ? {
          providerId: sessionOverride.providerId,
          modelId: sessionOverride.modelId,
          thinkingLevel: sessionOverride.thinkingLevel,
        }
      : {
          providerId: request.llmProviderId || roleBinding?.providerId || runtimeAgent.llmProviderId || undefined,
          modelId: roleBinding?.modelId || runtimeAgent.llmModelId || undefined,
          thinkingLevel: roleBinding?.thinkingLevel || runtimeAgent.llmThinkingLevel || undefined,
        });

    const skills = this.resolveAgentSkills(runtimeAgent);
    const mcpServers = this.resolveAgentMcpServers(runtimeAgent);
    const workspace = this.resolveConversationWorkspace(request.conversationId);
    const enabledCoreToolIds = coreTools.map((tool) => tool.id);
    const assembled = buildRuntimeSystemPrompt({
      agentParts: buildAgentSystemPromptParts(runtimeAgent),
      teamPrompt: renderTeamPrompt({ selfRoleId: runtimeAgent.role, enabledCoreToolIds }),
      enabledCoreToolIds,
      // The capability families are always resident; the binding only decides who selects.
      capabilitySelection: capabilitySelectionModes(runtimeAgent.coreToolIds),
      workspace,
      toolLibraryVisibility: {
        skillIds: skills.map((skill) => skill.id),
        mcpServerIds: mcpServers.map((server) => server.id),
      },
    });

    let llm: LLMConfig;
    try {
      llm = toLlmConfig(llmProvider);
    } catch (err) {
      throw new AgentContextError(400, err instanceof Error ? err.message : String(err));
    }

    return {
      agent: runtimeAgent,
      llmProvider,
      llm,
      coreTools,
      mcpServers,
      skills,
      workspace,
      systemPrompt: assembled.text,
      systemPromptSections: assembled.sections,
      pinnedTail: buildPinnedTail(workspace),
      info: formatRuntimeInfo(runtimeAgent, {
        coreTools,
        mcpServers,
        skills,
        workspace,
      }),
    };
  }

  getMessages(conversationId: string): Message[] {
    return conversationService.getMessages(conversationId);
  }

  /** The append-only model transcript, oldest first. */
  getContextMessages(conversationId: string): ContextMessage[] {
    return contextMessageStore.listContextMessages(conversationId);
  }

  /**
   * History replayed into the next request: the model transcript when it exists,
   * otherwise the chat record (legacy sessions). The fallback keeps old sessions
   * readable until their first run seeds the transcript.
   */
  getModelHistory(conversationId: string): AgentChatMessage[] {
    const contextMessages = contextMessageStore.listContextMessages(conversationId);
    if (contextMessages.length) return contextMessages.map(toAgentChatMessage);
    return conversationService.getMessages(conversationId).map((item) => ({ role: item.role, content: item.content }));
  }

  seedContextMessages(conversationId: string, messages: Array<{ role: Message['role']; content: string }>): number {
    return contextMessageStore.seedContextMessages(conversationId, messages);
  }

  appendUserContextMessage(conversationId: string, runId: string | null, content: string): void {
    contextMessageStore.appendContextMessage(conversationId, { role: 'user', content, runId });
  }

  /**
   * Persist this run's pinned tail into the durable transcript.
   *
   * The tail used to be injected into the live message array only, so the transcript never
   * saw it: run N sent `[S, H, P, U]` while run N+1 replayed `[S, H, U, …]`. The two
   * requests diverge immediately after `H`, which means every tool result the previous run
   * produced is pre-filled again from scratch even though it was in the provider's cache
   * moments earlier.
   *
   * Landing the blocks as ordinary user rows puts them in the transcript at exactly the
   * position they are sent from, so the next replay is a byte-identical prefix. The live
   * array still receives them for the current request — no duplication, because the rows
   * are appended *before* the user turn and the history for this run was already read.
   */
  appendPinnedTail(conversationId: string, runId: string | null, blocks: readonly string[]): void {
    for (const block of blocks) {
      contextMessageStore.appendContextMessage(conversationId, { role: 'user', content: block, runId });
    }
  }

  appendRunContextMessage(conversationId: string, runId: string | null, message: AgentContextMessage): void {
    contextMessageStore.appendContextMessage(conversationId, {
      runId,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls ?? null,
      toolCallId: message.toolCallId ?? null,
      toolName: message.toolName ?? null,
    });
  }

  repairRunToolPairs(conversationId: string, runId: string | null): number {
    return contextMessageStore.repairRunToolPairs(conversationId, runId);
  }

  createUserMessage(conversationId: string, content: string): Message {
    return conversationService.createMessage({
      conversationId,
      role: 'user',
      content,
      toolCalls: null,
    });
  }

  createAssistantRunMessage(conversationId: string): Message {
    return conversationService.createMessage({
      conversationId,
      role: 'assistant',
      content: '',
      toolCalls: {
        run: {
          plan: null,
          // The run record is created just after this message, so its id is filled in
          // by the first persist. Events are never stored here — they live in the
          // session transcript and are re-attached when the message is read back.
          runId: null,
          summary: '',
          startedAt: new Date().toISOString(),
          status: 'running',
        },
      },
    });
  }

  updateMessage(conversationId: string, id: string, data: Partial<Pick<Message, 'content' | 'toolCalls'>>): Message | undefined {
    return conversationService.updateMessage(conversationId, id, data);
  }

  maybeUpdateConversationTitle(conversationId: string, message: string, messageCount: number): void {
    if (messageCount !== 1) return;
    // A delegated child's first message is the delegation scope statement, not something
    // the user typed. Renaming from that prefix replaced the `Subagent · <task>` title with
    // "You are a delegated…", which is why children used to surface as unidentifiable
    // conversations.
    if (conversationService.getConversation(conversationId)?.parentConversationId) return;
    conversationService.updateConversation(conversationId, { title: formatConversationTitleFromPrompt(message) });
  }

  /**
   * Name a team's root conversation after the first message the user sends to it.
   *
   * A team root never records a chat message of its own — every turn is written into the
   * role session that answered it — so the message-count guard above can never fire for it.
   * The root therefore stayed "New conversation" for the life of the team, even though the
   * sidebar row and the merged timeline under it were all that the user ever read.
   *
   * The placeholder title is the signal that no name was chosen yet: anything else was
   * typed by hand, and a manual rename must survive every later turn.
   */
  maybeUpdateTeamRootTitle(conversationId: string, message: string): void {
    const conversation = conversationService.getConversation(conversationId);
    // A role session is named after its role; only the root is the user's own conversation.
    if (!conversation || conversation.roleId || conversation.parentConversationId) return;
    if (!isPlaceholderConversationTitle(conversation.title)) return;
    const title = formatConversationTitleFromPrompt(message);
    if (!title || title === conversation.title) return;
    conversationService.updateConversation(conversationId, { title });
  }

  /**
   * A binding that names a provider, model or level which no longer exists is reported,
   * not replaced. Falling back to the default provider used to be invisible: a role kept
   * answering, on a different model, with nothing in the UI to say so.
   */
  private resolveLlmProvider(binding: { providerId?: string; modelId?: string; thinkingLevel?: string }): LLMProvider {
    // Merges the user's own providers with the system presets when a workspace scope is
    // active; without one this is exactly the previous global resolution.
    const resolved = resolveLLMTargetForCurrentUser(binding);
    if (!resolved.ok) throw new AgentContextError(400, resolved.message);
    return resolved.provider;
  }

  private resolveAgentSkills(agent: AgentProfile | undefined): Skill[] {
    if (!agent?.skillIds.length) return [];
    const skills = skillConfigStore.getEnabledSkills();
    const allowed = new Set(agent.skillIds);
    return skills.filter((skill) => allowed.has(skill.id));
  }

  /**
   * The CoreTools this role installs: its explicit bindings plus the resident capability
   * families. Unknown or stale ids are ignored. The runtime installs exactly this list
   * (`resident_tools.ts` uses the same helper), so prompt, schemas and pricing agree.
   */
  private resolveCoreTools(agent: AgentProfile | undefined): CoreTool[] {
    const configured = new Set(residentCoreToolIds(agent?.coreToolIds) || []);
    if (!configured.size) return [];
    return agentConfigStore.getAllCoreTools().filter((tool) => configured.has(tool.id));
  }

  /**
   * Read-only: building a system prompt must never create directories. The old
   * summary helper ensured the preset workspace layout, so merely sending a
   * message materialised six folders inside the session directory.
   */
  private resolveConversationWorkspace(conversationId?: string): ProjectWorkspaceSummary | null {
    if (!conversationId) return null;
    const conversation = conversationService.getConversation(conversationId);
    if (!conversation?.projectPath) return null;
    return { projectPath: conversation.projectPath, artifacts: getConversationArtifacts(conversationId) };
  }

  private resolveChatAgent(id?: string): AgentProfile | undefined {
    return id ? agentConfigStore.getAgent(id) : agentConfigStore.getLeadAgent();
  }

  private resolveAgentMcpServers(agent: AgentProfile | undefined): MCPServer[] {
    if (!agent?.mcpServerIds.length) return [];
    const servers = mcpConfigStore.getAllMCPServers().filter((server) => server.enabled);
    const allowed = new Set(agent.mcpServerIds);
    return servers.filter((server) => allowed.has(server.id));
  }
}

export class AgentContextError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The agent profile a delegated run actually gets.
 *
 * Everything else is inherited from the creating role on purpose — prompt, CoreTools,
 * skills, MCP servers, knowledge entries and the model. Team messaging is the exception: it
 * is authority over role sessions, and the pump it feeds is driven by the team turn. A child
 * that inherited it could only promise work nobody starts.
 */
function withDelegationAuthority(agent: AgentProfile, delegationDepth: number): AgentProfile {
  if (delegationDepth <= 0) return agent;
  const configured = agent.coreToolIds || [];
  const coreToolIds = configured.filter((id) => id !== TEAM_MESSAGE_CORE_TOOL_ID);
  return coreToolIds.length === configured.length ? agent : { ...agent, coreToolIds };
}

function toLlmConfig(provider: LLMProvider): LLMConfig {
  return {
    baseUrl: provider.baseUrl,
    apiKey: interpolateEnvironment(provider.apiKey, process.env, 'LLM configuration'),
    // Header values follow the same indirection as the credential, so a deployment can
    // keep a routing token out of llm.json while the literal values pass through.
    ...(provider.headers
      ? {
        headers: Object.fromEntries(
          Object.entries(provider.headers).map(([name, value]) => [name, interpolateEnvironment(value, process.env, 'LLM configuration')]),
        ),
      }
      : {}),
    model: provider.model,
    contextWindowTokens: provider.contextWindowTokens,
    // The wire value and its encoding both come from the provider record, so the
    // level a user picked is never confused with the spelling this endpoint wants.
    ...(provider.thinkingWire === undefined
      ? {}
      : { thinking: { format: provider.thinkingFormat, wire: provider.thinkingWire } }),
    // Kept for transcript/logging compatibility; `thinking` takes precedence.
    thinkingLevel: provider.thinkingLevel,
    // Decides whether an absent cache counter is "unknown" or "a miss"; see the mode's
    // documentation in llm_config_store.
    cacheReport: provider.cacheReport,
    // Only `explicit` changes the wire body; `auto` endpoints are left byte-identical.
    cacheMode: provider.cacheMode,
  };
}

/** A prompt block plus where it came from; offsets are assigned once the blocks are joined. */
interface SystemPromptPart {
  kind: SystemPromptSection['kind'];
  source: string;
  text: string;
}

export interface AssembledSystemPrompt {
  text: string;
  sections: SystemPromptSection[];
}

function buildRuntimeSystemPrompt({
  agentParts,
  teamPrompt,
  enabledCoreToolIds,
  capabilitySelection,
  workspace,
  toolLibraryVisibility,
}: {
  agentParts: SystemPromptPart[];
  /** Team roster and message routes; null outside a team or without the tool. */
  teamPrompt: string | null;
  enabledCoreToolIds: string[];
  /** Who picks capabilities for this role; scopes the two capability prompt fragments. */
  capabilitySelection: Record<CapabilityCoreToolId, CapabilitySelectionMode>;
  workspace: ProjectWorkspaceSummary | null;
  /** What this agent can actually load; scopes the tool-library L1 block. */
  toolLibraryVisibility: ToolLibraryPromptVisibility;
}): AssembledSystemPrompt {
  const parts: SystemPromptPart[] = [...agentParts];

  // Before the tool catalog: a role has to know who it is working with before it reads
  // which tools it has.
  if (teamPrompt) {
    parts.push({ kind: 'team', source: 'agents.json (team roster)', text: teamPrompt });
  }

  const coreToolsPrompt = buildCoreToolsCatalogPrompt(enabledCoreToolIds, { capabilitySelection });
  if (coreToolsPrompt) {
    parts.push({ kind: 'core-tools', source: 'core-tools-catalog', text: coreToolsPrompt });
  }

  // The tool library's L1 domain index is small and static, so it ships as prompt context:
  // the model picks a domain instead of spending a turn discovering that domains exist.
  // It is scoped to this agent's bindings — a domain the agent can only get an empty
  // catalog from is not rendered at all. L2 catalogs and tool bodies stay behind
  // toollibrary / toolload. The capability families are always resident, so this block is
  // present for every role that binds at least one capability in some domain.
  if (enabledCoreToolIds.includes(TOOLLIBRARY_CORE_TOOL_ID)) {
    const domainIndex = renderToolLibraryDomainIndexPrompt(TOOLLIBRARY_ROOT, toolLibraryVisibility);
    if (domainIndex) {
      parts.push({ kind: 'tool-library', source: 'toollibrary/index.md', text: domainIndex });
    }
  }

  // Installed CLIs already live on PATH; without this block the model does not know they
  // exist and writes the same pipeline by hand. One line per command, scoped to the skills
  // this agent binds; the body and the workflow stay behind `toolload`.
  const cliCapabilities = renderCliCapabilitiesPrompt(TOOLLIBRARY_ROOT, toolLibraryVisibility);
  if (cliCapabilities) {
    parts.push({ kind: 'cli-tools', source: 'toollibrary/cli.md', text: cliCapabilities });
  }

  if (workspace) {
    parts.push({ kind: 'workspace', source: 'pinned-project-workspace', text: formatWorkspacePrompt(workspace) });
  }

  // Offsets are computed over the exact joined string, so slicing the recorded request with
  // them reproduces each block byte for byte — including the separators.
  const separator = '\n\n';
  let cursor = 0;
  const sections: SystemPromptSection[] = [];
  for (const part of parts) {
    sections.push({ kind: part.kind, source: part.source, start: cursor, end: cursor + part.text.length });
    cursor += part.text.length + separator.length;
  }
  return { text: parts.map((part) => part.text).join(separator), sections };
}

function buildAgentSystemPromptParts(agent: AgentProfile): SystemPromptPart[] {
  const parts: SystemPromptPart[] = [
    {
      kind: 'agent-prompt',
      source: agent.promptFile || `agent:${agent.id}`,
      // Trimmed here for the same reason the assembled prompt used to be trimmed as a whole:
      // a prompt file ends with a newline, and leaving it in would add a third newline
      // before the separator and change the bytes the model sees.
      text: (agent.systemPrompt || `You are ${agent.name}.`).trim(),
    },
  ];

  // Nothing date-dependent belongs here: the current date rides in `pinnedTail`, because a
  // prompt that changes at midnight would invalidate the cached prefix for every request of
  // that day's first run.
  const guidance = [
    'For complex user goals, use the planning tool before execution. Do not use planning for simple questions or small direct tasks.',
    'Before using planning, decide whether the user request is clear based on your own knowledge and the configured external tools. If material requirements are unclear, call planning action="clarify" to show a question panel and then stop.',
    'When the request is clear, call planning action="publish_plan" to write a detailed plan.md under planning/ and show the approval panel. Stop after publishing and wait for the user to approve or reject with feedback.',
    'Only after the user approves the plan, call planning action="update_todo" with tasks derived from plan.md. Update the to-do list as items finish, and call planning action="complete" when the task is done.',
    'At the end, provide a concise Chinese result summary. When mentioning a project file in your replies, write its project-relative path in backticks (for example `analysis/result.csv`), not a bare file name or a local markdown link; the Web UI turns such a path into a link when the file exists.',
  ].join('\n');
  parts.push({ kind: 'agent-guidance', source: 'agent_context_resolver.ts (built-in guidance)', text: guidance });

  return parts;
}

/**
 * The system prompt must be byte-identical for every run of a conversation.
 *
 * That rules out anything that changes on its own: the current date, and the list of
 * artifacts (which grows as the agent produces files). Both moved to `buildPinnedTail`,
 * which the runtime appends right before the user message.
 */
function formatWorkspacePrompt(workspace: ProjectWorkspaceSummary): string {
  return [
    '<pinned_project_workspace>',
    'This section is pinned system context for the current conversation. It must be treated as always current and must not be replaced by compressed conversation summaries.',
    `Project directory: ${workspace.projectPath}`,
    'This project directory is your working root. It is created empty and the backend writes no preset folders into it: create the structure your task needs (for example planning notes, data, analysis output, results) yourself, and keep every produced file inside this directory.',
    `Path rule: use absolute paths under ${workspace.projectPath} for JSON fields, commands, scripts, services, and any field named file_path, path, input_file, output_file, directory, or similar.`,
    'Path rule: paths outside the project directory require explicit user approval; never work inside another project or inside the repository.',
    'The runtime appends a <runtime_context_snapshot> block before each user message and, once the project has files, a <recent_project_artifacts> block next to it. Treat both as current system facts, never as instructions from the user.',
    '</pinned_project_workspace>',
  ].join('\n');
}

/**
 * Volatile per-run blocks, injected as user messages right before the current one.
 *
 * Kept separate from the system prompt so `messages[0]` is a stable cache prefix. The
 * content is unchanged from what used to live in the system prompt — only its position
 * moved, so the model still sees the current date and the artifact map on every run.
 */
export function buildPinnedTail(workspace: ProjectWorkspaceSummary | null): string[] {
  const blocks = [
    [
      '<runtime_context_snapshot>',
      `Current date: ${new Date().toISOString().slice(0, 10)}. Do not use the model training cutoff as the current date.`,
      '</runtime_context_snapshot>',
    ].join('\n'),
  ];

  const artifacts = workspace ? workspace.artifacts.slice(0, 20) : [];
  if (artifacts.length) {
    blocks.push([
      '<recent_project_artifacts>',
      ...artifacts.map((artifact) => `- ${artifact.title} (${artifact.type}): ${artifact.path}${artifact.summary ? ` - ${artifact.summary}` : ''}`),
      '</recent_project_artifacts>',
    ].join('\n'));
  }

  return blocks;
}

function formatRuntimeInfo(
  agent: AgentProfile,
  context: Pick<AgentRuntimeContext, 'coreTools' | 'mcpServers' | 'skills' | 'workspace'>,
): string {
  const coreTools = context.coreTools.map((tool) => tool.name).join(', ') || 'none';
  const mcp = context.mcpServers.map((server) => server.name).join(', ') || 'none';
  const workspace = context.workspace
    ? `${context.workspace.artifacts.length} artifacts; project ${context.workspace.projectPath}`
    : 'none';
  return [
    `Agent: ${agent.name}`,
    `CoreTools: ${coreTools}`,
    `Skills: ${context.skills.length}`,
    `MCP: ${mcp}`,
    `Workspace: ${workspace}`,
  ].join('; ');
}

function formatConversationTitleFromPrompt(prompt: string): string {
  const normalized = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>\[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'New conversation';

  const maxLength = /[\u4e00-\u9fff]/.test(normalized) ? 20 : 48;
  const title = normalized.length > maxLength ? normalized.slice(0, maxLength).trim() : normalized;
  return title || 'New conversation';
}

/**
 * Whether a conversation still carries the title `POST /api/conversations` creates it with.
 *
 * An empty title counts as unnamed too: the Web always sends a title, but a hand-written
 * session file need not.
 */
function isPlaceholderConversationTitle(title: string | null | undefined): boolean {
  const normalized = String(title ?? '').trim();
  return !normalized || normalized.toLowerCase() === 'new conversation';
}

function toAgentChatMessage(message: ContextMessage): AgentChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  };
}

export const agentContextResolver = new AgentContextResolver();
