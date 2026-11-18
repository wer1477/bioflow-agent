import type { AgentChatRequest } from './types.js';
import { assessProjectBoundary, resolveConversationProjectPath } from './project_boundary.js';
import { classifyAutoToolCall } from './security_classifier.js';
import { assessToolSecurity, normalizeSecurityMode, type ToolSecurityAssessment } from './security_policy.js';

/** Internal security-policy seam for a single runtime tool call. */
export async function assessRuntimeToolSecurity(
  request: AgentChatRequest,
  toolName: string,
  arguments_: Record<string, unknown>,
  toolDescription?: string,
): Promise<ToolSecurityAssessment> {
  const mode = normalizeSecurityMode(request.securityMode);
  // The project sandbox is checked before the risk heuristics: a path outside
  // the project always needs confirmation, however harmless the tool looks.
  const boundary = assessProjectBoundary(mode, resolveConversationProjectPath(request.conversationId), arguments_);
  if (boundary) return boundary;

  let assessment = assessToolSecurity(mode, toolName, arguments_);
  if (assessment.decision !== 'classify') return assessment;

  const classification = await classifyAutoToolCall(request.llm, {
    userMessage: request.userMessage,
    toolName,
    toolDescription,
    arguments: arguments_,
    heuristicRisk: assessment.risk,
  }, request.abortSignal);
  assessment = { decision: classification.decision, risk: assessment.risk, reason: classification.reason };
  return assessment;
}
