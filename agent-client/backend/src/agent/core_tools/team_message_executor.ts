import { TEAM_ROLE_IDS, getTeamConfig, getAgent, type AgentRole } from '../config/agent_config_store.js';
import { judgeRelay, type RelayGateVerdict } from '../team/relay_gate.js';
import { buildTeamMessage, type TeamMessage, type TeamMessageKind } from '../team/message.js';
import { enqueueTeamMessage } from '../team/message_bus.js';
import { appendTeamMessage, readTeamState, resolveTeamRoot } from '../team/team_service.js';
import type { Conversation } from '../config/conversation_types.js';
import type { CoreToolExecutionContext } from '../core_tools_runtime.js';

/**
 * Send one message to another team role.
 *
 * The tool only *records* the message: the caller's run is still inside its own conversation,
 * and switching conversations mid-tool-call would leave the transcript inconsistent. The team
 * pump drains the bus when the run ends and executes each message in the target role's own
 * session, then hands the answer back to whoever asked.
 *
 * Authority is asymmetric on purpose. The lead can delegate, append and relay. A role can
 * deliver to the lead and relay to a peer — and a peer relay has to pass the biod gate first.
 */
const LEAD_ACTIONS: readonly TeamMessageKind[] = ['delegate', 'append', 'relay'];
const ROLE_ACTIONS: readonly TeamMessageKind[] = ['deliver', 'relay'];

export async function executeTeamMessage(args: Record<string, unknown>, context: CoreToolExecutionContext): Promise<string> {
  const action = String(args.action ?? '').trim() as TeamMessageKind;
  const requestedTo = String(args.to ?? '').trim();
  const task = String(args.task ?? '').trim();
  const content = String(args.content ?? '').trim();
  const expect = String(args.expect ?? '').trim();
  const why = String(args.why ?? '').trim();

  const team = getTeamConfig();
  const lead = team.leadRoleId;
  const caller = context.agent?.role;

  if ((context.delegationDepth ?? 0) > 0) {
    // The resolver already strips the tool from a delegated child's list; this keeps the
    // authority boundary true even if a call arrives down another path.
    return failure('messages_not_allowed', '委派的子 agent 不能给团队发消息：消息只能由角色在自己的 run 里发起。');
  }
  if (!caller || !(TEAM_ROLE_IDS as readonly string[]).includes(caller)) {
    return failure('not_a_team_role', '当前 agent 不是团队成员，无法发送团队消息。');
  }

  const isLead = caller === lead;
  const allowed = isLead ? LEAD_ACTIONS : ROLE_ACTIONS;
  if (!allowed.includes(action)) {
    return failure('action_not_allowed', `${caller} 不能使用 ${action || '(空)'}。可用：${allowed.join(' / ')}。`);
  }

  // `deliver` is the one action whose target is fixed: it always goes to the lead.
  const to = action === 'deliver' ? lead : requestedTo;
  if (!to) {
    return failure(action === 'deliver' ? 'target_required' : 'target_required', '需要 to：消息发给哪个角色。');
  }
  if (!(TEAM_ROLE_IDS as readonly string[]).includes(to)) {
    return failure('unknown_role', `未知角色：${to}。可用角色：${TEAM_ROLE_IDS.join(' / ')}`);
  }
  if (to === caller) {
    return failure('self_message', '不需要把消息发给自己。');
  }
  if (!isLead && action === 'relay' && to === lead) {
    return failure('use_deliver', `给 ${lead} 的消息请用 action="deliver"。`);
  }

  const body = action === 'delegate' ? task : content;
  if (!body) {
    return action === 'delegate'
      ? failure('task_required', '委派需要 task：目标、输入、期望产出。')
      : failure('content_required', `${action} 需要 content：要传达的内容。`);
  }
  if (action !== 'delegate' && expect) {
    return failure('expect_not_allowed', '只有委派可以带 expect。');
  }
  if (!context.conversationId) {
    return failure('no_conversation', '当前工具调用没有会话上下文，无法发送。');
  }

  const root: Conversation | undefined = resolveTeamRoot(context.conversationId);
  if (!root || root.roleId) {
    return failure('not_a_team', '当前会话不属于任何团队，无法发送。');
  }
  const after = args.after;
  let dependsOn: string[] | undefined;
  if (after !== undefined) {
    if (action !== 'delegate' || !Array.isArray(after) || after.length > 16 ||
        after.some((id) => typeof id !== 'string' || !id.trim())) {
      return failure('invalid_dependencies', 'after 只接受委派任务 ID 的数组。');
    }
    const state = readTeamState(root.id);
    dependsOn = [...new Set<string>(after)];
    const known = new Set([
      ...Object.keys(state.handoffOutcomes),
      ...state.pendingDeliveries.filter((item) => item.message.kind === 'delegate').map((item) => item.message.id),
    ]);
    if (dependsOn.some((id) => !known.has(id))) {
      return failure('unknown_dependency', 'after 必须引用本项目会话中已登记的委派。');
    }
  }
  const target = getAgent(to);
  if (!target) {
    return failure('unknown_role', `角色 ${to} 尚未配置。`);
  }

  // A role asking a peer for something is the only hop the gate judges. The lead does not
  // relay to itself, and a delivery is not a hop between peers.
  let gate: RelayGateVerdict | null = null;
  if (!isLead && action === 'relay') {
    gate = await judgeRelay({ from: caller, to, body, why });
    if (gate.verdict !== 'allow') {
      appendTeamMessage(root.id, buildTeamMessage({
        kind: 'relay', from: caller as AgentRole, to: to as AgentRole, body, gate,
      }));
    }

    if (gate.verdict === 'reject') {
      return failure(
        'relay_rejected',
        `转述被驳回（${gate.source}，置信度 ${gate.confidence.toFixed(2)}）：${(gate.reasons.length ? gate.reasons : ['没有给出理由']).join('；')}。改用 action="deliver" 向 ${lead} 说明。`,
      );
    }
    if (gate.verdict === 'escalate') {
      // Low confidence is the lead's call, not a silent pass and not a block: the request
      // becomes a delivery so the lead sees it on its next turn and can decide.
      const escalation = buildTeamMessage({
        kind: 'deliver',
        from: caller as AgentRole,
        to: lead,
        body: [
          `[待裁决] ${caller} 想向 ${to} 发起一次转述，判断层没能决定（${gate.source}）。`,
          `请求内容：${body}`,
          why ? `理由：${why}` : '',
        ].filter(Boolean).join('\n'),
      });
      enqueueTeamMessage(root.id, escalation);
      return JSON.stringify({
        ok: true,
        pending: 'lead_decision',
        messageId: escalation.id,
        note: `这次转述已交给 ${lead} 判断，暂时不会送达 ${to}。先继续你手上的工作；${lead} 的决定会作为消息回到你的会话。`,
      });
    }
  }

  const message: TeamMessage = buildTeamMessage({
    kind: action,
    from: caller as AgentRole,
    to: to as AgentRole,
    body,
    expect,
    dependsOn,
    ...(gate ? { gate: { ...gate } } : {}),
  });
  enqueueTeamMessage(root.id, message);

  const note = isLead
    ? `消息已发给 ${target.label}。接收角色会在本轮结束后开始。若下一步依赖结果，请结束本轮，随后系统将结果交回 ${lead}。`
    : action === 'deliver'
      ? `已交付给 ${lead}。本轮结束后 ${lead} 会读到你这条消息。`
      : `已排队发给 ${target.label}。若下一步依赖回答，请结束本轮，让系统调度接收角色并把回复送回你的会话。`;

  return JSON.stringify({
    ok: true,
    messageId: message.id,
    action,
    role: { id: to, label: target.label, name: target.name },
    ...(gate ? { gate: { verdict: gate.verdict, confidence: gate.confidence, source: gate.source } } : {}),
    note,
  });
}

/**
 * The lead keeps visibility without paying for a model turn: every peer relay lands in its
 * transcript as a notice. The message says what was asked and how the gate ruled, so the lead
 * can object later instead of being blind to a hop it never saw.
 */
function failure(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}
