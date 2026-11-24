import { v4 as uuidv4 } from 'uuid';
import type { AgentRole } from '../config/agent_config_store.js';

/**
 * A handoff card is what the next role reads instead of the previous role's transcript.
 *
 * Cards are built by the runtime, never authored by a model: goal and acceptance criteria
 * come from the dispatch, the summary is the child's own final answer, and artifacts are
 * whatever the child actually wrote. That keeps the cross-role channel trustworthy even
 * when a role is having a bad day.
 */
export interface HandoffArtifactReference {
  id: string;
  path: string;
  version: string;
}

export interface HandoffCard {
  id: string;
  messageId?: string;
  fromRole: AgentRole;
  toRole: AgentRole;
  goal: string;
  summary: string;
  artifacts: string[];
  artifactVersions?: HandoffArtifactReference[];
  openQuestions: string[];
  confidence: 'low' | 'medium' | 'high';
  createdAt: string;
}

const MAX_SUMMARY_CHARS = 800;

export function buildHandoffCard(input: {
  messageId?: string;
  fromRole: AgentRole;
  toRole: AgentRole;
  goal: string;
  answer: string;
  artifacts: string[];
  artifactVersions?: HandoffArtifactReference[];
  failed?: boolean;
}): HandoffCard {
  const answer = String(input.answer || '').trim();
  const summary = answer.length > MAX_SUMMARY_CHARS ? `${answer.slice(0, MAX_SUMMARY_CHARS)}\n…[truncated]` : answer;
  return {
    id: uuidv4(),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    fromRole: input.fromRole,
    toRole: input.toRole,
    goal: input.goal,
    summary: summary || '（该角色没有给出结论）',
    artifacts: input.artifacts,
    ...(input.artifactVersions?.length ? { artifactVersions: input.artifactVersions } : {}),
    openQuestions: [],
    confidence: input.failed ? 'low' : 'medium',
    createdAt: new Date().toISOString(),
  };
}

/** Render the cards a role should see, newest last, as one prompt block. */
export function renderHandoffBlock(cards: HandoffCard[]): string {
  if (!cards.length) return '';
  const lines = [
    '<team_handoffs>',
    '以下是团队最近的交接卡（运行时生成，不是模型转述）。需要细节时读卡片里列出的文件。',
  ];
  for (const card of cards) {
    lines.push(
      `- [${card.fromRole} → ${card.toRole}] ${card.goal}`,
      `  结论：${card.summary.replace(/\n/g, '\n  ')}`,
      ...(card.artifacts.length ? [`  产出：${card.artifacts.join(', ')}`] : []),
      ...(card.artifactVersions?.length
        ? [`  产出版本：${card.artifactVersions.map((item) => `${item.path} [${item.id} @ ${item.version}]`).join(', ')}`]
        : []),
      ...(card.confidence !== 'high' ? [`  置信度：${card.confidence}`] : []),
    );
  }
  lines.push('</team_handoffs>');
  return lines.join('\n');
}

/** How many cards the team keeps on disk. */
export const HANDOFF_CARD_KEEP = 12;
