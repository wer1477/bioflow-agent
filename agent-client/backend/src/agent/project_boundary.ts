import { getConversation } from './config/conversation_service.js';
import { inspectToolPath } from './core_tools/project_paths.js';
import type { SecurityMode, ToolSecurityAssessment } from './security_policy.js';

/**
 * The tool arguments that name a path the tool will touch. Shell commands are
 * deliberately excluded: their targets cannot be resolved statically, and they
 * already carry their own risk classification.
 */
const PATH_ARGUMENT_KEYS = ['workdir', 'file_path', 'path'] as const;

/** Project directory bound to a conversation, or null when unknown. */
export function resolveConversationProjectPath(conversationId?: string): string | null {
  if (!conversationId) return null;
  return getConversation(conversationId)?.projectPath ?? null;
}

/**
 * Boundary guard for the project sandbox: a path argument outside the project
 * directory asks for confirmation instead of being silently resolved. Approval
 * reuses the existing security-approval channel, so there is no second
 * mechanism to maintain.
 */
export function assessProjectBoundary(
  mode: SecurityMode,
  projectPath: string | null | undefined,
  arguments_: Record<string, unknown>,
): ToolSecurityAssessment | null {
  if (mode === 'unrestricted') return null;
  const root = String(projectPath || '').trim();
  if (!root) return null;
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = arguments_?.[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const { inside, path: resolved } = inspectToolPath(root, value);
    if (!inside) {
      return {
        decision: 'ask',
        risk: 'unknown',
        reason: `"${key}" resolves to ${resolved}, which is outside the project directory ${root}.`,
      };
    }
  }
  return null;
}
