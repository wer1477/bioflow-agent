import fs from 'node:fs';
import express from 'express';
import { agentService, AgentServiceError } from '../../agent/service/agent_service.js';
import {
  AgentContextError,
  agentContextResolver,
} from '../../agent/service/agent_context_resolver.js';
import { runtimeContextManager, type ManagedHistory } from '../../agent/context_manager.js';
import { loadConversationStats, mergeConversationStats } from '../../agent/conversation_stats.js';
import { listConversationActivity } from '../../agent/conversation_activity.js';
import { securityApprovalStore, type SecurityApprovalDecision } from '../../agent/security_approval_store.js';
import {
  createConversation,
  deleteConversation,
  getAllConversations,
  getConversation,
  getMessages,
  listDescendantConversations,
  resolveAnsweringAgentId,
  updateConversation,
} from '../../agent/config/conversation_service.js';
import {
  displaySubagentTitle,
  listSubagentConversations,
  summarizeSubagents,
} from '../../agent/subagent_catalog.js';
import {
  appendHandoffCard,
  describeTeam,
  ensureRoleSession,
  listRoleSessions,
  readTeamState,
  resolveTeamRoot,
  updateTeamState,
} from '../../agent/team/team_service.js';
import { decideRole } from '../../agent/team/role_router.js';
import {
  buildHandoffCard,
  renderHandoffBlock,
  type HandoffCard,
  type HandoffArtifactReference,
} from '../../agent/team/dispatch.js';
import {
  drainTeamMessages, enqueueTeamMessage, finishTeamMessage, recoverTeamMessages, startTeamMessage,
} from '../../agent/team/message_bus.js';
import { buildTeamMessage, renderTeamMessagePrompt, type TeamMessage } from '../../agent/team/message.js';
import { TEAM_ROLE_IDS, getTeamConfig, type AgentRole } from '../../agent/config/agent_config_store.js';
import {
  clearSessionLlmOverride,
  setSessionLlmOverride,
} from '../../agent/config/session_llm_override_store.js';
import { resolveLLMTargetForCurrentUser } from '../../auth/user_llm_store.js';
import { getConversationArtifacts } from '../../agent/config/workspace_artifact_store.js';
import {
  getAgentRun,
  getAgentRunSteps,
  getConversationRuns,
} from '../../agent/config/run_store.js';
import { findProject, listProjects } from '../../agent/config/project_service.js';
import { projectKeyForPath } from '../../agent/config/session_paths.js';
import {
  readTranscript,
  resolveTranscriptBlobPath,
  toAgentEvents,
  TranscriptLogError,
} from '../../agent/transcript_reader.js';
import { readScopedPanels, panelScopeOf, panelStateOwnerId } from '../../agent/panel_scope.js';
import { readTranscriptTree } from '../../agent/transcript_tree.js';
import { runRegistry } from '../../agent/run_registry.js';
import {
  readRunManifest,
  renderRunManifestMarkdown,
} from '../../agent/provenance/run_manifest.js';
import {
  applyGoalMutation,
  canStartGoalRound,
  GoalTransitionError,
  renderGoalRoundPrompt,
  type GoalMutationRequest,
  type GoalOperation,
  type GoalState,
} from '../../agent/conversation_panels.js';
import { appendConversationStateEvent } from '../../agent/transcript_store.js';
import { readCurrentGoal } from '../../agent/core_tools/goal_executor.js';
import type { GoalRoundRequest } from '../../agent/service/agent_service.js';

const router = express.Router();
const activeRunControllers = new Map<string, AbortController>();
const activeConversationControllers = new Map<string, AbortController>();

/** Web actions that may be expressed against the goal document. */
const GOAL_OPERATIONS_BY_ACTION: Record<string, GoalOperation> = {
  create: 'create',
  edit: 'edit',
  pause: 'pause',
  resume: 'resume',
  clear: 'clear',
};

/**
 * Hard ceiling on automatic rounds started by one HTTP request.
 *
 * The goal's own `maxRounds` is the product limit; this is the transport's backstop so a
 * corrupted or absurd goal document cannot make one request run unbounded.
 */
const MAX_AUTOMATIC_ROUNDS_PER_REQUEST = 20;

/**
 * Record that an active goal ran out of rounds before it could finish.
 *
 * Stopping silently would leave an `active` goal with no visible reason for being idle,
 * so the loop writes the same durable blocked state the model would have written.
 */
function stopExhaustedGoal(
  conversationId: string,
  goal: GoalState,
  emit: (event: unknown) => void,
): void {
  try {
    const next = applyGoalMutation(goal, {
      operation: 'block',
      blockedReason: {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxRounds} rounds.`,
      },
    });
    appendConversationStateEvent(conversationId, { type: 'goal_change', operation: 'block', goal: next });
    emit({ type: 'goal_change', operation: 'block', goal: next });
  } catch {
    /* The goal document is already the truth; failing to annotate it must not kill the stream. */
  }
}

function decodeUploadHeader(req: express.Request, header: string): string {
  const value = req.get(header);
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${header} must be URI encoded.`);
  }
}

/**
 * 客户端要按项目分组会话，因此这里补上派生出来的 projectKey：
 * 转义规则只在后端实现一份，前端不必重复。
 */
function toClientConversation<T extends { projectPath: string | null }>(conversation: T): T & { projectKey: string | null } {
  return { ...conversation, projectKey: conversation.projectPath ? projectKeyForPath(conversation.projectPath) : null };
}

function getConversationOr404(id: string, res: express.Response) {
  const conversation = getConversation(id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }
  return conversation;
}

/** Query values arrive as strings; anything unparseable is treated as "not supplied". */
function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The agent a conversation's next request would run.
 *
 * A role session always runs its own role: the transcript *is* that role's work, so a
 * caller-supplied id would describe a different prompt than the one on disk. A plain
 * conversation follows the caller's selection, because that is what a run would use.
 */
function conversationAgentId(conversation: { roleId?: string | null }, req: express.Request): string | undefined {
  if (conversation.roleId) return conversation.roleId;
  return typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
}

/**
 * Resolve the context snapshot the conversation's next request would use.
 *
 * Both read-only probes (`/context-budget` and `/stats`) share this helper so the
 * managed history, budget and checkpoint they report cannot drift apart.
 */
function resolveManagedContext(conversationId: string, req: express.Request, agentId: string | undefined) {
  const context = agentContextResolver.resolve({
    conversationId,
    agentId,
    llmProviderId: typeof req.query.llmProviderId === 'string' ? req.query.llmProviderId : undefined,
  });
  const history = agentContextResolver.getModelHistory(conversationId);
  const managed = runtimeContextManager.buildManagedHistory({
    conversationId,
    history,
    context,
    userMessage: '',
  });
  return { context, history, managed };
}

/**
 * The compact composer reading of a managed-context snapshot.
 *
 * The meter's three categories mirror DSH's breakdown: system prompt, tool schemas, and
 * everything else the request carries (message bodies, the pending user turn and the
 * fixed request overhead). Percent is measured against the raw window — the same figure
 * the ring shows — not against the compaction limit.
 *
 * `agentLabel` names whose window this is. A team root reports the role the team is on,
 * and the number is meaningless without saying so.
 */
function toContextStats(managed: ManagedHistory, agentLabel?: string | null) {
  const { budget, checkpoint } = managed;
  const breakdown = budget.breakdown;
  return {
    usedTokens: budget.tokenEstimate,
    contextWindowTokens: budget.contextWindowTokens,
    percent: budget.contextWindowTokens > 0
      ? Math.min(100, Math.round((budget.tokenEstimate / budget.contextWindowTokens) * 100))
      : 0,
    breakdown: {
      system: breakdown.system,
      tools: breakdown.tools,
      messages: breakdown.messages + breakdown.user + breakdown.overhead,
    },
    softExceeded: budget.softExceeded,
    hardExceeded: budget.hardExceeded,
    windowSource: budget.contextWindowSource,
    windowReason: budget.contextWindowReason,
    agentLabel: agentLabel || null,
    checkpoint: checkpoint ? {
      createdAt: checkpoint.createdAt,
      triggerReason: checkpoint.triggerReason,
    } : null,
  };
}

/**
 * Conversations the user owns.
 *
 * A delegated child belongs to its parent conversation, not to the project's session
 * list: the Web opens it from the parent header (`GET /:id/subagents`). Filtering here
 * keeps every list consumer — sidebar, project page, search, ungrouped list — honest
 * without each of them re-deriving the rule.
 */
function listVisibleConversations(): ReturnType<typeof getAllConversations> {
  return getAllConversations().filter((conversation) => !conversation.parentConversationId);
}

router.get('/', (req, res) => {
  const projectKey = String(req.query.project || '').trim();
  if (!projectKey) {
    res.json({ conversations: listVisibleConversations().map(toClientConversation) });
    return;
  }
  if (projectKey === 'none') {
    const orphanIds = new Set(listProjects().orphans.map((orphan) => orphan.id));
    res.json({ conversations: listVisibleConversations().filter((conversation) => orphanIds.has(conversation.id)).map(toClientConversation) });
    return;
  }
  const project = findProject(projectKey);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ conversations: listVisibleConversations().filter((conversation) => conversation.projectPath === project.path).map(toClientConversation) });
});

/**
 * Live activity: which conversations are running right now, and when each of them last
 * finished.
 *
 * Deliberately separate from the list endpoint above: the conversation list is loaded on
 * navigation, while this one is polled every couple of seconds to keep the sidebar's
 * running/completed indicators honest. Role sessions and delegated children never appear in
 * the list, but their runs are folded into the root's entry, which is the only place the
 * user looks.
 */
router.get('/activity', (req, res) => {
  res.json(listConversationActivity());
});

router.post('/', (req, res) => {
  // A session always belongs to a project; the project directory is its working root.
  const projectKey = String(req.body?.project || '').trim();
  if (!projectKey) {
    res.status(400).json({ error: 'A project is required to create a conversation.' });
    return;
  }
  const project = findProject(projectKey);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const conversation = createConversation({
    title: String(req.body?.title || 'New conversation'),
    pinned: Boolean(req.body?.pinned),
    projectPath: project.path,
  });
  res.status(201).json({ conversation: toClientConversation(conversation) });
});

router.get('/:id', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  // A delegated child is rendered as a breadcrumb under its parent, so the parent's
  // title travels with the child instead of costing the Web a second request.
  const parent = conversation.parentConversationId ? getConversation(conversation.parentConversationId) : undefined;
  res.json({
    // A child renamed by its first message before the title guard landed is shown under
    // its delegation name; the stored record is left alone.
    conversation: toClientConversation({ ...conversation, title: displaySubagentTitle(conversation) }),
    parent: parent ? { id: parent.id, title: parent.title } : null,
    messages: getMessages(conversation.id),
  });
});

/**
 * The parent's delegation panel: direct children and their current state.
 *
 * Polled while anything runs, so it stays cheap — status, timing and message counts,
 * never message bodies.
 */
router.get('/:id/subagents', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const subagents = listSubagentConversations(conversation.id);
  res.json({
    parent: { id: conversation.id, title: conversation.title },
    ...summarizeSubagents(subagents),
    subagents,
  });
});

/**
 * The team a conversation belongs to: role roster, routing mode and active role.
 *
 * Accepts either the root or any of its role sessions, so the Web can call it with
 * whichever conversation is on screen.
 */
router.get('/:id/team', (req, res) => {
  const team = describeTeam(req.params.id);
  if (!team) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json(team);
});

/** Switch the team into manual mode and/or pick the role that answers next. */
router.put('/:id/team', (req, res) => {
  const root = resolveTeamRoot(req.params.id);
  if (!root) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const mode = req.body?.mode;
  const activeRoleId = req.body?.activeRoleId;
  if (mode !== undefined && mode !== 'auto' && mode !== 'manual') {
    res.status(400).json({ error: "mode must be 'auto' or 'manual'." });
    return;
  }
  if (activeRoleId !== undefined && (typeof activeRoleId !== 'string' || !(TEAM_ROLE_IDS as readonly string[]).includes(activeRoleId))) {
    res.status(400).json({ error: `Unknown team role: ${String(activeRoleId)}` });
    return;
  }
  try {
    const state = updateTeamState(root.id, {
      ...(mode === undefined ? {} : { mode }),
      ...(activeRoleId === undefined ? {} : { activeRoleId }),
      // A manual pick is itself the routing decision, so the panel can explain it.
      ...(activeRoleId === undefined ? {} : {
        lastRoute: {
          roleId: activeRoleId as (typeof TEAM_ROLE_IDS)[number],
          confidence: 1,
          source: 'manual' as const,
          reason: '用户手动选择',
          at: new Date().toISOString(),
        },
      }),
    });
    // Picking a role also materialises its session: the Web switches into that
    // conversation right away, and an id that only appears after the first message
    // would make the click feel like it did nothing.
    if (activeRoleId !== undefined) ensureRoleSession(root.id, activeRoleId as (typeof TEAM_ROLE_IDS)[number]);
    // Auto mode releases a manual pick: the next turn goes wherever the router sends it,
    // and the panel should stop claiming a role the user no longer chose.
    if (mode === 'auto' && activeRoleId === undefined) {
      const leadRoleId = describeTeam(root.id)?.leadRoleId;
      if (leadRoleId && state.activeRoleId !== leadRoleId) {
        updateTeamState(root.id, { activeRoleId: leadRoleId });
      }
    }
    res.json(describeTeam(root.id)!);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Set (or replace) the model one role uses **in this session**.
 *
 * This is what the composer's model picker writes. It never touches `agents.json` or the
 * user's durable `user_role_bindings`: the override belongs to the session, dies with the
 * session, and is resolved above both (see `agent_context_resolver`).
 *
 * The role is implicit, not a user choice: a role session speaks for its own role, and the
 * root speaks for the role that last took over — which is exactly "the model follows the
 * role that is answering", the behaviour the picker advertises.
 */
router.put('/:id/llm-override', (req, res) => {
  const conversation = getConversationOr404(req.params.id, res);
  if (!conversation) return;
  const root = resolveTeamRoot(conversation.id);
  const team = root ? describeTeam(root.id) : undefined;
  if (!root || !team) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const requestedRoleId = req.body?.roleId;
  if (requestedRoleId !== undefined && (typeof requestedRoleId !== 'string' || !(TEAM_ROLE_IDS as readonly string[]).includes(requestedRoleId))) {
    res.status(400).json({ error: `Unknown team role: ${String(requestedRoleId)}` });
    return;
  }
  if (conversation.roleId && requestedRoleId !== undefined && requestedRoleId !== conversation.roleId) {
    res.status(400).json({ error: `A role session can only change its own role: ${conversation.roleId}` });
    return;
  }
  const roleId = (conversation.roleId || requestedRoleId || team.activeRoleId) as AgentRole;
  const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId.trim() : '';
  const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
  const thinkingLevel = typeof req.body?.thinkingLevel === 'string' ? req.body.thinkingLevel.trim() : '';
  if (!providerId) {
    res.status(400).json({ error: 'providerId is required.' });
    return;
  }
  // Validate through the same per-user catalog the run path resolves against: an override
  // that cannot run has to be rejected here, not on the next send.
  const resolved = resolveLLMTargetForCurrentUser({
    providerId,
    modelId: modelId || undefined,
    thinkingLevel: thinkingLevel || undefined,
  });
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.message, code: resolved.reason });
    return;
  }
  try {
    // Store the resolved ids, not the request's: an omitted model would otherwise mean "the
    // provider default", and that default can change under the session later.
    const override = setSessionLlmOverride(root.id, roleId, {
      providerId: resolved.provider.id,
      modelId: resolved.provider.model,
      ...(resolved.provider.thinkingLevelName ? { thinkingLevel: resolved.provider.thinkingLevelName } : {}),
    });
    res.json({ team: describeTeam(root.id)!, override });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Drop one role's session override: the role goes back to its binding. */
router.delete('/:id/llm-override', (req, res) => {
  const conversation = getConversationOr404(req.params.id, res);
  if (!conversation) return;
  const root = resolveTeamRoot(conversation.id);
  const team = root ? describeTeam(root.id) : undefined;
  if (!root || !team) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const rawRoleId = req.query.roleId;
  const requestedRoleId = typeof rawRoleId === 'string' ? rawRoleId : undefined;
  if (requestedRoleId !== undefined && !(TEAM_ROLE_IDS as readonly string[]).includes(requestedRoleId)) {
    res.status(400).json({ error: `Unknown team role: ${requestedRoleId}` });
    return;
  }
  if (conversation.roleId && requestedRoleId !== undefined && requestedRoleId !== conversation.roleId) {
    res.status(400).json({ error: `A role session can only change its own role: ${conversation.roleId}` });
    return;
  }
  const roleId = (conversation.roleId || requestedRoleId || team.activeRoleId) as AgentRole;
  clearSessionLlmOverride(root.id, roleId);
  res.json({ team: describeTeam(root.id)! });
});

/**
 * Merged timeline of a team: the root's own history plus every role session, in time order.
 *
 * This is the read model the team view renders. It is a projection, not a copy — each
 * message keeps its own conversation id, so drilling into a role session is just a normal
 * conversation read.
 */
router.get('/:id/team/messages', (req, res) => {
  const root = resolveTeamRoot(req.params.id);
  if (!root) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const messages = [
    ...getMessages(root.id).map((message) => ({ ...message, roleId: null as string | null })),
    ...listRoleSessions(root.id).flatMap((session) => (
      getMessages(session.id).map((message) => ({ ...message, roleId: session.roleId || null }))
    )),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json({ rootId: root.id, messages });
});

router.patch('/:id', (req, res) => {
  const conversation = updateConversation(req.params.id, {
    title: req.body?.title,
    pinned: req.body?.pinned,
  });
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ conversation: toClientConversation(conversation) });
});

router.delete('/:id', (req, res) => {
  if (!deleteConversation(req.params.id)) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.status(204).end();
});

router.get('/:id/messages', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  // `getMessages` attaches each run's events, rebuilt from the transcript.
  res.json({ messages: getMessages(conversation.id) });
});

/**
 * Current panel state folded from the transcript.
 *
 * The Web shell renders the to-do dock and the goal strip from this instead of scanning
 * historical events itself: the fold runs once, on the side that owns the log, so a
 * reload cannot disagree with a live run about what the current list or goal is.
 *
 * A team read covers the root plus every role session (`panel_scope.ts`): the root never
 * runs, so folding only the requested conversation would answer "no goal, no to-do list"
 * for a team that is full of them. `scope` says which rule was applied.
 */
router.get('/:id/panels', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  try {
    const scoped = readScopedPanels(conversation.id);
    res.json({
      ...scoped.panels,
      scope: scoped.scope,
      rootId: scoped.rootId,
      tornTail: scoped.tornTail,
    });
  } catch (error) {
    if (error instanceof TranscriptLogError) {
      res.status(500).json({ error: 'Transcript log is unreadable', detail: error.message });
      return;
    }
    throw error;
  }
});

/**
 * Mutate the goal from the Web shell.
 *
 * Rejected while a run is active: the running recorder owns the log sequence, and a
 * second writer computing its own sequence would corrupt it. The model changes the goal
 * from inside a run through its tools, which share the recorder.
 */
router.post('/:id/goal', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  // A run owns its conversation's log; a second writer would duplicate a sequence. The
  // request map covers the admission window and the run registry covers runs that never
  // came through HTTP (a delegated child). A team mutation checks every session it would
  // fold, because the goal is team-wide even though the record lands on the root.
  const scopeIds = panelScopeOf(conversation.id).sources.map((source) => source.conversationId);
  if (runRegistry.anyActive(scopeIds) || activeConversationControllers.has(conversation.id)) {
    res.status(409).json({ error: 'A run is active for this conversation. Stop it before changing the goal.' });
    return;
  }
  const action = String(req.body?.action || '').trim();
  const operation = GOAL_OPERATIONS_BY_ACTION[action];
  if (!operation) {
    res.status(400).json({ error: `action must be one of ${Object.keys(GOAL_OPERATIONS_BY_ACTION).join(', ')}` });
    return;
  }
  const request: GoalMutationRequest = {
    operation,
    ...(typeof req.body?.objective === 'string' ? { objective: req.body.objective } : {}),
    ...(req.body?.max_rounds !== undefined ? { maxRounds: Number(req.body.max_rounds) } : {}),
    ...(action === 'blocked' && typeof req.body?.blocked_reason === 'string'
      ? { blockedReason: { code: 'user-reported', message: req.body.blocked_reason } }
      : {}),
  };
  try {
    const current = readCurrentGoal(conversation.id);
    const next = applyGoalMutation(current, request);
    // Team state documents live on the root: it never runs, so the append cannot race a
    // recorder, and every role reads it back through the merged scope.
    appendConversationStateEvent(panelStateOwnerId(conversation.id), { type: 'goal_change', operation, goal: next });
    res.json({ goal: next });
  } catch (error) {
    if (error instanceof GoalTransitionError) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

router.get('/:id/context-budget', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  try {
    const { context, history, managed } = resolveManagedContext(conversation.id, req, conversationAgentId(conversation, req));
    res.json({
      conversationId: conversation.id,
      agent: {
        id: context.agent.id,
        name: context.agent.name,
        label: context.agent.label,
        role: context.agent.role,
      },
      llmProvider: {
        id: context.llmProvider.id,
        name: context.llmProvider.name,
        model: context.llmProvider.model,
        thinkingLevel: context.llmProvider.thinkingLevelName || null,
      },
      // The checkpoint's tokenEstimate and watermarkRatio were measured against whichever
      // window was in force back then. Naming the window here is what lets a reader tell an
      // old watermark from a current one instead of comparing them to today's denominator.
      contextWindowTokens: context.llmProvider.contextWindowTokens || null,
      checkpoint: managed.checkpoint ? {
        id: managed.checkpoint.id,
        createdAt: managed.checkpoint.createdAt,
        triggerReason: managed.checkpoint.triggerReason,
        tokenEstimate: managed.checkpoint.tokenEstimate,
        watermarkRatio: managed.checkpoint.watermarkRatio,
      } : null,
      // Present only when a stored checkpoint was rejected: the conversation panel can
      // then explain why the model is not seeing its own earlier summary.
      ...(managed.discardedCheckpoint ? { discardedCheckpoint: managed.discardedCheckpoint } : {}),
      budget: managed.budget,
      managedMessageCount: managed.messages.length,
      rawMessageCount: history.length,
    });
  } catch (err) {
    if (err instanceof AgentContextError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Session totals for the composer pills: whole-log activity/token usage plus the same
 * managed-context snapshot `/context-budget` serves, so the footer has one request.
 */
router.get('/:id/stats', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  // A team root is a container, not a transcript: its own log is empty and the work lives
  // in the role sessions the merged timeline already shows. Count the whole subtree —
  // root, role sessions and anything either of them delegated — so the footer cannot
  // silently omit work that ran in a subagent.
  const roleSessions = listRoleSessions(conversation.id);
  const subtree = [conversation, ...listDescendantConversations(conversation.id)];
  const stats = mergeConversationStats(subtree.map((each) => loadConversationStats(each.id)));

  // A context window belongs to a request, not to a team. Report the role the team is on:
  // that is where the next turn lands unless the router decides otherwise, and the label
  // says whose window the number is.
  const activeSession = roleSessions.find((session) => session.roleId === readTeamState(conversation.id).activeRoleId)
    || conversation;
  let context: ReturnType<typeof toContextStats> | null = null;
  try {
    const { context: runtimeContext, managed } = resolveManagedContext(
      activeSession.id,
      req,
      conversationAgentId(activeSession, req),
    );
    context = toContextStats(managed, runtimeContext.agent.label || runtimeContext.agent.name);
  } catch (err) {
    // Activity and token totals are folded from the transcript and stand on their own. A
    // binding that only this probe trips must not blank the whole footer; `/context-budget`
    // still reports the same failure loudly to whoever is diagnosing the setup.
    if (!(err instanceof AgentContextError)) throw err;
  }
  res.json({
    conversationId: conversation.id,
    activity: stats.activity,
    tokenUsage: stats.tokenUsage,
    context,
  });
});

router.get('/:id/runs', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ runs: getConversationRuns(conversation.id) });
});

router.get('/:id/runs/:runId', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const run = getAgentRun(conversation.id, req.params.runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const metadata = (run.metadata || {}) as Record<string, unknown>;
  res.json({
    run,
    steps: getAgentRunSteps(conversation.id, run.id),
    manifestPath: typeof metadata.manifestPath === 'string' ? metadata.manifestPath : null,
  });
});

/**
 * Provenance of one run: code version, environment, tool parameters and hashed
 * artifacts. The manifest is written asynchronously when the run finishes, so a
 * terminal run can briefly answer 404 `manifest_not_ready`; that is a retryable
 * state, not an error in the run itself. `?format=markdown` returns the same data
 * as a reproducibility card for reports.
 */
router.get('/:id/runs/:runId/manifest', async (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const run = getAgentRun(conversation.id, req.params.runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const manifest = await readRunManifest(conversation.id, run.id);
  if (!manifest) {
    res.status(404).json({
      error: 'Run manifest is not available yet',
      code: 'manifest_not_ready',
      runStatus: run.status,
    });
    return;
  }
  if (req.query.format === 'markdown') {
    res.type('text/markdown; charset=utf-8').send(renderRunManifestMarkdown(manifest));
    return;
  }
  res.json({ manifest });
});

router.get('/:id/transcript', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const runId = typeof req.query.runId === 'string' && req.query.runId ? req.query.runId : undefined;
  try {
    const result = readTranscript(conversation.id, {
      runId,
      afterSequence: toOptionalNumber(req.query.afterSequence),
      limit: toOptionalNumber(req.query.limit),
    });
    if (runId && result.runs.length === 0) {
      res.status(404).json({ error: 'Run not found in this transcript' });
      return;
    }
    res.json(result);
  } catch (error) {
    if (error instanceof TranscriptLogError) {
      // A damaged committed prefix is a server-side fault, not a client error: report it
      // as such instead of returning a partial history that looks complete.
      res.status(500).json({ error: 'Transcript log is unreadable', detail: error.message });
      return;
    }
    throw error;
  }
});

/**
 * The trajectory of a whole conversation tree: one node per conversation, with its runs.
 *
 * The log is per conversation but the product is a tree (root + role sessions + delegated
 * children), so "what happened in this session" otherwise means enumerating the team and
 * each subagent list from the client. Events stay where they are: this is the map, and
 * `GET /:id/transcript` remains the drill-down.
 *
 * A log that cannot be read is reported per node as `damaged` rather than failing the
 * whole tree; the single-conversation route still answers 500 for that node.
 */
router.get('/:id/transcript/tree', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const maxDepth = toOptionalNumber(req.query.maxDepth);
  res.json(readTranscriptTree(conversation.id, { maxDepth }));
});

router.get('/:id/transcript/agent-events', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const runId = typeof req.query.runId === 'string' && req.query.runId ? req.query.runId : '';
  if (!runId) {
    res.status(400).json({ error: 'runId is required' });
    return;
  }
  try {
    // The trace view reads a run's activity back from the transcript rather than from
    // the copy embedded in the assistant message.
    const result = readTranscript(conversation.id, { runId, unlimited: true });
    if (result.runs.length === 0) {
      res.status(404).json({ error: 'Run not found in this transcript' });
      return;
    }
    res.json({ runId, events: toAgentEvents(result.events), tornTail: result.tornTail });
  } catch (error) {
    if (error instanceof TranscriptLogError) {
      res.status(500).json({ error: 'Transcript log is unreadable', detail: error.message });
      return;
    }
    throw error;
  }
});

router.get('/:id/transcript/blob', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const ref = String(req.query.ref || '').trim();
  if (!ref) {
    res.status(400).json({ error: 'ref is required' });
    return;
  }
  let blobPath: string;
  try {
    blobPath = resolveTranscriptBlobPath(conversation.id, ref);
  } catch (error) {
    if (error instanceof TranscriptLogError) {
      res.status(400).json({ error: 'Invalid transcript blob reference' });
      return;
    }
    throw error;
  }
  if (!fs.existsSync(blobPath)) {
    res.status(404).json({ error: 'Transcript blob not found' });
    return;
  }
  // The complete tool result the model only saw a preview of; served verbatim.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(fs.readFileSync(blobPath, 'utf8'));
});

router.post('/:id/runs/:runId/cancel', (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const run = getAgentRun(conversation.id, req.params.runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const controller = activeRunControllers.get(run.id);
  if (!controller) {
    res.json({ ok: false, runId: run.id, cancelled: false, reason: 'run_not_active' });
    return;
  }
  controller.abort();
  activeRunControllers.delete(run.id);
  res.json({ ok: true, runId: run.id, cancelled: true });
});

/**
 * One HTTP request may carry several rounds: the user's turn plus any automatic goal
 * continuations it triggers. They share one NDJSON stream so the client sees a single
 * uninterrupted activity, and the loop stops on the first sign that the stream or the
 * goal no longer wants another round (client gone, cancel pressed, goal stopped).
 */
async function runRounds(options: {
  conversationId: string;
  message: string;
  agentId?: string | null;
  llmProviderId?: string | null;
  abortSignal: AbortSignal;
  emit: (event: unknown) => void;
  isOpen: () => boolean;
}): Promise<void> {
  const { conversationId, message, agentId, llmProviderId, abortSignal, emit, isOpen } = options;
  let turnMessage = message;
  let goalRound: GoalRoundRequest | undefined;
  let automaticRounds = 0;
  for (;;) {
    await agentService.runCompletion({
      conversationId,
      message: turnMessage,
      agentId: agentId || undefined,
      llmProviderId: llmProviderId || undefined,
      abortSignal,
      ...(goalRound ? { goalRound } : {}),
    }, {
      emit,
      isOpen,
    });
    if (!isOpen() || abortSignal.aborted) break;
    const goal = readCurrentGoal(conversationId);
    if (!goal || goal.phase !== 'active' || !goal.autoContinue) break;
    if (!canStartGoalRound(goal)) {
      stopExhaustedGoal(conversationId, goal, emit);
      break;
    }
    if (automaticRounds >= MAX_AUTOMATIC_ROUNDS_PER_REQUEST) break;
    automaticRounds += 1;
    goalRound = { goalId: goal.id, revision: goal.revision, round: goal.roundsStarted + 1 };
    turnMessage = renderGoalRoundPrompt(goal, goalRound.round);
  }
}

/**
 * Shared NDJSON lifecycle for a run: lock, headers, disconnect handling, error framing.
 *
 * `lockId` is the conversation whose runs this request owns; `run` may lock further
 * conversations (a team run locks the role session it delegates to as well).
 */
async function streamRun(
  req: express.Request,
  res: express.Response,
  lockId: string,
  run: (io: {
    emit: (event: unknown) => void;
    isOpen: () => boolean;
    abortSignal: AbortSignal;
    lock: (conversationId: string) => void;
  }) => Promise<void>,
): Promise<void> {
  if (activeConversationControllers.has(lockId)) {
    res.status(409).json({ error: 'A run is already active for this conversation. Cancel it or wait for it to finish before starting another.' });
    return;
  }

  const abortController = new AbortController();
  const locked = [lockId];
  activeConversationControllers.set(lockId, abortController);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  let open = true;
  let currentRunId = '';
  const cancelForDisconnect = () => {
    open = false;
    if (!res.writableEnded) abortController.abort();
  };
  req.once('aborted', cancelForDisconnect);
  res.once('close', cancelForDisconnect);

  const emit = (event: unknown) => {
    if (isRunStatusWithId(event)) {
      currentRunId = event.runId;
      activeRunControllers.set(currentRunId, abortController);
    }
    if (!open) return;
    res.write(`${JSON.stringify(event)}\n`);
  };

  try {
    await run({
      emit,
      isOpen: () => open,
      abortSignal: abortController.signal,
      lock: (conversationId: string) => {
        if (locked.includes(conversationId)) return;
        locked.push(conversationId);
        activeConversationControllers.set(conversationId, abortController);
      },
    });
  } catch (err) {
    const statusCode = err instanceof AgentServiceError ? err.statusCode : 500;
    emit({
      type: 'error',
      statusCode,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (currentRunId) activeRunControllers.delete(currentRunId);
    for (const conversationId of locked) {
      if (activeConversationControllers.get(conversationId) === abortController) {
        activeConversationControllers.delete(conversationId);
      }
    }
    if (!res.destroyed) res.end();
  }
}


/**
 * Run one team turn: the routed role works, the lead may dispatch, dispatched roles run in
 * their own sessions, and control returns to the lead for acceptance.
 *
 * Dispatch is the only cross-session hop, and it only ever originates from the lead — a role
 * has no dispatch tool, so the graph cannot recurse.
 */
async function runTeamRounds(options: {
  rootId: string;
  session: { id: string };
  roleId: AgentRole;
  message: string;
  llmProviderId?: string | null;
  abortSignal: AbortSignal;
  emit: (event: unknown) => void;
  isOpen: () => boolean;
  lock: (conversationId: string) => void;
}): Promise<void> {
  const { rootId, abortSignal, emit, isOpen, lock } = options;
  const team = getTeamConfig();
  let sessionId = options.session.id;
  let roleId = options.roleId;
  let message = options.message;
  let goalRound: GoalRoundRequest | undefined;
  let automaticRounds = 0;
  let nextLeadMessages: TeamMessage[] = [];
  let leadDeliveryFailed = false;
  recoverTeamMessages(rootId);

  const relay = (event: unknown) => {
    if (!event || typeof event !== 'object') return emit(event);
    if (nextLeadMessages.length && (event as { type?: string }).type === 'error') {
      leadDeliveryFailed = true;
    }
    emit({ ...(event as Record<string, unknown>), roleId, roleSessionId: sessionId });
  };

  for (;;) {
    leadDeliveryFailed = false;
    for (const delivery of nextLeadMessages) startTeamMessage(rootId, delivery.id);
    await agentService.runCompletion({
      conversationId: sessionId,
      message,
      agentId: roleId,
      llmProviderId: options.llmProviderId || undefined,
      abortSignal,
      ...(goalRound ? { goalRound } : {}),
    }, { emit: relay, isOpen });
    if (!isOpen() || abortSignal.aborted) break;
    if (leadDeliveryFailed) {
      recoverTeamMessages(rootId);
      break;
    }
    for (const delivery of nextLeadMessages) finishTeamMessage(rootId, delivery.id);
    nextLeadMessages = [];

    const messages = drainTeamMessages(rootId);
    if (messages.length) {
      const { cards, delivered } = await runTeamMessages({ rootId, messages, abortSignal, emit, isOpen, lock });
      // A role-to-role chain that never addressed the lead consumes the whole turn: the
      // asking role was already woken with its answer inside the pump.
      if (!cards.length && !delivered.length) break;

      const leadSession = ensureRoleSession(rootId, team.leadRoleId);
      lock(leadSession.id);
      emit({
        type: 'role_switch',
        fromRoleId: cards[0]?.fromRole || delivered[0]?.from || team.leadRoleId,
        fromRoles: [...cards.map((card) => card.fromRole), ...delivered.map((entry) => entry.from)],
        toRoleId: team.leadRoleId,
        roleSessionId: leadSession.id,
        reason: delivered.length ? '角色交付，交回 PI 处理' : '派发完成，交回 PI 验收',
      });
      sessionId = leadSession.id;
      roleId = team.leadRoleId;
      goalRound = undefined;
      nextLeadMessages = delivered;
      message = [
        ...(cards.length ? [renderAcceptancePrompt(cards)] : []),
        ...(delivered.length ? [renderDeliveredPrompt(delivered)] : []),
      ].join('\n\n');
      continue;
    }

    const goal = readCurrentGoal(sessionId);
    if (!goal || goal.phase !== 'active' || !goal.autoContinue) break;
    if (!canStartGoalRound(goal)) {
      stopExhaustedGoal(sessionId, goal, relay);
      break;
    }
    if (automaticRounds >= MAX_AUTOMATIC_ROUNDS_PER_REQUEST) break;
    automaticRounds += 1;
    goalRound = { goalId: goal.id, revision: goal.revision, round: goal.roundsStarted + 1 };
    message = renderGoalRoundPrompt(goal, goalRound.round);
  }
}

/** A role turn never chains further than this inside one request. */
const MAX_TEAM_HOPS = 16;

interface TeamDeliveryResult {
  /** Handoff cards for work the lead asked for. */
  cards: HandoffCard[];
  /** Messages addressed to the lead itself; the caller runs the lead with these. */
  delivered: TeamMessage[];
}

/**
 * Execute every pending message, at most `maxConcurrentDispatches` targets at a time.
 *
 * Two shapes share the pump. A batch the lead sent runs in parallel like before. Anything a
 * role sent is processed one at a time, because it can chain: a relay runs the target and
 * then feeds the answer back to whoever asked.
 */
async function runTeamMessages(context: {
  rootId: string;
  messages: TeamMessage[];
  abortSignal: AbortSignal;
  emit: (event: unknown) => void;
  isOpen: () => boolean;
  lock: (conversationId: string) => void;
}): Promise<TeamDeliveryResult> {
  const { rootId, abortSignal, emit, isOpen, lock } = context;
  const team = getTeamConfig();
  const lead = team.leadRoleId;
  // The dispatched role starts from its own session, so the only shared state it gets is
  // what the team already wrote down.
  const cards: HandoffCard[] = [];
  const delivered: TeamMessage[] = [];

  const fromLead = context.messages.filter((message) => message.from === lead && message.to !== lead);
  const chained: TeamMessage[] = context.messages.filter((message) => !fromLead.includes(message));

  const runOne = async (message: TeamMessage): Promise<{
    answer: string;
    artifacts: string[];
    artifactVersions: HandoffArtifactReference[];
    failed: boolean;
  }> => {
    const session = ensureRoleSession(rootId, message.to);
    lock(session.id);
    startTeamMessage(rootId, message.id);
    emit({
      type: 'role_switch',
      fromRoleId: message.from,
      toRoleId: message.to,
      roleSessionId: session.id,
      messageId: message.id,
      reason: `${message.from} ${MESSAGE_REASON[message.kind] || '发送消息'}`,
    });

    let answer = '';
    let failed = false;
    const priorVersions = new Map(
      getConversationArtifacts(session.id).map((artifact) => [artifact.id, artifact.updatedAt]),
    );
    try {
      await agentService.runCompletion({
        conversationId: session.id,
        message: renderDispatchPrompt(message, readTeamState(rootId).cards),
        agentId: message.to,
        abortSignal,
      }, {
        emit: (event: unknown) => {
          if (event && typeof event === 'object') {
            const response = event as { type?: string; content?: unknown };
            if (response.type === 'content' && typeof response.content === 'string') answer += response.content;
            if (response.type === 'error') failed = true;
          }
          if (!event || typeof event !== 'object') return emit(event);
          emit({ ...(event as Record<string, unknown>), roleId: message.to, roleSessionId: session.id });
        },
        isOpen,
      });
    } catch (err) {
      answer = `执行失败：${err instanceof Error ? err.message : String(err)}`;
      failed = true;
    }

    const artifactVersions = getConversationArtifacts(session.id)
      .filter((artifact) => artifact.path && priorVersions.get(artifact.id) !== artifact.updatedAt)
      .map((artifact) => ({ id: artifact.id, path: artifact.path, version: artifact.updatedAt }));
    return { answer, artifacts: artifactVersions.map((artifact) => artifact.path), artifactVersions,
      failed: failed || !answer.trim() };
  };

  if (fromLead.length) {
    const limit = Math.max(1, team.limits.maxConcurrentDispatches);
    const byRole = new Map<AgentRole, TeamMessage[]>();
    for (const message of fromLead) {
      const queue = byRole.get(message.to) ?? [];
      queue.push(message);
      byRole.set(message.to, queue);
    }
    const groups = [...byRole.values()];
    let next = 0;
    const worker = async () => {
      while (isOpen() && !abortSignal.aborted) {
        const group = groups[next++];
        if (!group) return;
        for (const message of group) {
          if (!isOpen() || abortSignal.aborted) return;
          const { answer, artifacts, artifactVersions, failed } = await runOne(message);
          if (!isOpen() || abortSignal.aborted) return;
          const card = buildHandoffCard({
            messageId: message.id,
            fromRole: message.to,
            toRole: message.from,
            goal: message.body,
            answer,
            artifacts,
            artifactVersions,
            failed: failed || answer.startsWith('执行失败'),
          });
          appendHandoffCard(rootId, card);
          emit({ type: 'handoff_card', card });
          cards.push(card);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, worker));
  }

  // Anything a role sent: one at a time, because a relay answers back to its sender.
  let hops = 0;
  while (chained.length && isOpen() && !abortSignal.aborted) {
    hops += 1;
    if (hops > MAX_TEAM_HOPS) {
      emit({ type: 'error', message: `团队消息在一次请求内超过 ${MAX_TEAM_HOPS} 跳，已停止继续转发。` });
      break;
    }
    const message = chained.shift() as TeamMessage;
    if (message.to === lead) {
      // The lead answers in the outer loop: a role's delivery is a lead turn, not a card.
      delivered.push(message);
      continue;
    }
    const { answer, artifacts, failed } = await runOne(message);
    if (!isOpen() || abortSignal.aborted) break;
    if (message.kind !== 'reply') {
      const reply = buildTeamMessage({
        kind: 'reply',
        from: message.to,
        to: message.from,
        body: renderRelayReply(failed && !answer.trim() ? '执行失败：该角色未返回内容。' : answer, artifacts),
        replyTo: message.id,
      });
      enqueueTeamMessage(rootId, reply);
    } else {
      finishTeamMessage(rootId, message.id);
    }
    chained.push(...drainTeamMessages(rootId));
  }

  return { cards, delivered };
}

/** 每种消息读起来必须像它本来的意思：派活、续活、传话、交付、回复。 */
const MESSAGE_REASON: Partial<Record<TeamMessage['kind'], string>> = {
  delegate: '派发任务',
  append: '追加任务',
  relay: '转述信息',
  deliver: '交付',
  reply: '回复',
};

const MESSAGE_TRAILER: Partial<Record<TeamMessage['kind'], string>> = {
  delegate: '在你的工作目录里完成它，结束时给出结论、关键证据和产物路径；不要反问用户，也不要再去派发。',
  append: '结合它继续手上的工作，结束时同样给出结论、关键证据和产物路径。',
  relay: '按这条信息处理并给出结论；如果它与当前任务无关，直接说明即可。',
  deliver: '这是角色交付给你的内容，请你判断并处理。',
  reply: '这是对方针对你上一条消息的回复，可以据此继续手上的工作。',
};

function renderDispatchPrompt(message: TeamMessage, cards: HandoffCard[] = []): string {
  const dependencies = message.dependsOn;
  const relevant = dependencies?.length
    ? cards.filter((card) => card.messageId && dependencies.includes(card.messageId))
    : cards;
  const handoffs = renderHandoffBlock(relevant);
  return [
    ...(handoffs ? [handoffs, ''] : []),
    renderTeamMessagePrompt(message),
    '',
    `这是 ${message.from} 发来的${MESSAGE_REASON[message.kind] || '消息'}。${MESSAGE_TRAILER[message.kind] || ''}`.trim(),
  ].join('\n');
}

/** What the lead reads after work it asked for came back. */
function renderAcceptancePrompt(cards: HandoffCard[]): string {
  const blocks = cards.map((card) => [
    `${card.fromRole} 的任务：${card.goal}`,
    `结论：${card.summary}`,
    ...(card.artifacts.length ? [`产出：${card.artifacts.join(', ')}`] : []),
  ].join('\n'));
  return [
    '[团队派发结果]',
    ...blocks,
    '',
    '请你验收：达标就直接向用户汇报结论与产物；不达标再派发一次或自己补做。',
  ].join('\n\n');
}

/** What the lead reads when a role delivered something to it. */
function renderDeliveredPrompt(messages: TeamMessage[]): string {
  return [
    ...messages.map((message) => renderTeamMessagePrompt(message)),
    '',
    '以上是角色主动交付给你的消息。需要它继续时直接给它发消息；不需要时向用户说明你的判断。',
  ].join('\n\n');
}

/** A relayed answer, packaged so the asking role can act on it without re-reading a file. */
function renderRelayReply(answer: string, artifacts: string[]): string {
  const body = String(answer || '').trim();
  const clipped = body.length > 1200 ? `${body.slice(0, 1200)}\n…[truncated]` : body;
  return [
    clipped || '（对方没有给出结论）',
    ...(artifacts.length ? ['', `产出：${artifacts.join(', ')}`] : []),
  ].join('\n');
}

router.post('/:id/runs', async (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const message = String(req.body?.message || '').trim();
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  // A role session answers as its role, and a delegated child as the role that created it,
  // without the caller having to send `agentId`.
  const agentId = resolveAnsweringAgentId(
    conversation,
    typeof req.body?.agentId === 'string' ? req.body.agentId : undefined,
  );
  await streamRun(req, res, conversation.id, async ({ emit, isOpen, abortSignal }) => {
    await runRounds({
      conversationId: conversation.id,
      message,
      agentId,
      llmProviderId: req.body?.llmProviderId,
      abortSignal,
      emit,
      isOpen,
    });
    emit({ type: 'done' });
  });
});

/**
 * The team's run entry: route the turn to a role, run it in that role's own conversation,
 * and relay its events into this stream tagged with the role that produced them.
 *
 * The merged team timeline is a read model over the role sessions (see `GET /:id/team/messages`),
 * so nothing is copied here — the relay only decides what the live stream looks like.
 */
router.post('/:id/team/runs', async (req, res) => {
  const root = resolveTeamRoot(req.params.id);
  if (!root) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const message = String(req.body?.message || '').trim();
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const requestedRoleId = req.body?.roleId;
  if (requestedRoleId !== undefined && (typeof requestedRoleId !== 'string' || !(TEAM_ROLE_IDS as readonly string[]).includes(requestedRoleId))) {
    res.status(400).json({ error: `Unknown team role: ${String(requestedRoleId)}` });
    return;
  }

  await streamRun(req, res, root.id, async ({ emit, isOpen, abortSignal, lock }) => {
    // The root is the conversation the user sees, so its first message names it — the same
    // way a single-agent conversation is named when its first message lands. Role sessions
    // keep their role labels; they are never the row the user reads.
    agentContextResolver.maybeUpdateTeamRootTitle(root.id, message);

    const state = readTeamState(root.id);
    const decision = await decideRole({
      conversationId: root.id,
      message,
      mode: state.mode,
      activeRoleId: state.activeRoleId,
      requestedRoleId: requestedRoleId as (typeof TEAM_ROLE_IDS)[number] | undefined,
    });
    emit({ type: 'route_decision', ...decision });

    const session = ensureRoleSession(root.id, decision.roleId);
    lock(session.id);
    updateTeamState(root.id, { activeRoleId: decision.roleId, lastRoute: decision });

    await runTeamRounds({
      rootId: root.id,
      session,
      roleId: decision.roleId,
      message,
      llmProviderId: req.body?.llmProviderId,
      abortSignal,
      emit,
      isOpen,
      lock,
    });
    emit({ type: 'done' });
  });
});


router.post('/:id/runs/:runId/security-approvals/:approvalId', (req, res) => {
  const conversation = getConversationOr404(req.params.id, res);
  if (!conversation) return;
  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'deny') {
    res.status(400).json({ error: 'decision must be approve or deny.' });
    return;
  }
  const accepted = securityApprovalStore.respond(
    conversation.id,
    req.params.runId,
    req.params.approvalId,
    decision as SecurityApprovalDecision,
  );
  if (!accepted) {
    res.status(404).json({ error: 'Security approval request was not found or has expired.' });
    return;
  }
  res.json({ ok: true, decision });
});

function isRunStatusWithId(event: unknown): event is { type: 'run_status'; runId: string } {
  return Boolean(
    event
      && typeof event === 'object'
      && (event as { type?: unknown }).type === 'run_status'
      && typeof (event as { runId?: unknown }).runId === 'string'
      && (event as { runId: string }).runId,
  );
}

export default router;
