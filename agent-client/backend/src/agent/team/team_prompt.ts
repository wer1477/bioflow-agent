import { getAgent, getTeamConfig, type AgentRole } from '../config/agent_config_store.js';
import { TEAM_MESSAGE_CORE_TOOL_ID } from '../core_tools/ids.js';

/**
 * The `<team>` block every team role reads at the top of its system prompt.
 *
 * Two things have to be true for the block to be useful and honest:
 *
 * 1. It describes the route that actually exists. The runtime delivers a message into the
 *    target's own conversation; nothing is "passed to the lead for forwarding". A prompt that
 *    said otherwise would teach roles to report approvals that never happened.
 * 2. It only lists the actions this role can actually call. The tool schema is per role, so
 *    the prose has to be per role too, or the model will try an action it does not have.
 *
 * The roster comes from `agents.json` (`label` + `description`) — one source of truth shared
 * with the biod relay gate and with the lead's own choice of `to`.
 */
export function renderTeamPrompt(input: {
  selfRoleId: AgentRole;
  enabledCoreToolIds: string[];
}): string | null {
  if (!input.enabledCoreToolIds.includes(TEAM_MESSAGE_CORE_TOOL_ID)) return null;
  const team = getTeamConfig();
  if (!team.roles.includes(input.selfRoleId)) return null;

  const isLead = input.selfRoleId === team.leadRoleId;
  const self = getAgent(input.selfRoleId);
  const lines: string[] = ['<team>'];

  const selfDuty = self?.description ? `（${self.description}）` : '';
  lines.push(isLead
    ? `你是 ${input.selfRoleId}${selfDuty}。团队由你统一组织。`
    : `你是 ${input.selfRoleId}${selfDuty}。团队由 ${team.leadRoleId} 统一组织。`);

  lines.push('', isLead ? '成员：' : '其他成员：');
  for (const roleId of team.roles) {
    if (roleId === input.selfRoleId) continue;
    const agent = getAgent(roleId);
    const duty = agent?.description ? `：${agent.description}` : '';
    lines.push(`- ${roleId}（${agent?.label || roleId}）${duty}`);
  }

  lines.push('', '通信：');
  if (isLead) {
    lines.push(
      '- 新任务 → team_message action="delegate"，写 task；附 expect 说明什么样的结果算达标。',
      '- 对已发出任务的补充或修正 → action="append"，写 content。',
      '- 转达信息给对方 → action="relay"，写 content。',
      '- 消息会追加到对方的会话；对方在自己的会话里作答，结果回到你这里验收。',
    );
  } else {
    lines.push(
      `- 交付结果、提问，或说明无法完成的原因 → team_message action="deliver"，消息送达 ${team.leadRoleId}。`,
      '- 需要其他成员的补充信息 → action="relay" 并写明 to。系统会先做一次必要性判断：',
      '  通过则直接送达对方会话，对方的回答直接回到你这里；被驳回会带理由返回，',
      `  这时改用 deliver 向 ${team.leadRoleId} 说明情况。`,
    );
  }
  lines.push('- 每条消息必须自包含：对方看不到你的上下文，也不知道你之前做过什么。');
  lines.push('</team>');
  return lines.join('\n');
}
