import { createHash } from 'node:crypto';
import path from 'node:path';
import { readProjectFile, writeProjectFile } from '../../config/project_files.js';
import type {
  PlanAuditResult,
  PlanAuditRunner,
  PlanStep,
  PlanToolCandidate,
  StepAudit,
} from './contracts.js';
import { parsePlanSteps } from './plan-steps.js';

/**
 * `toollibrary action="plan-audit"` handler.
 *
 * It reads the design document, parses its `plan-steps` block, asks the decision service for
 * a report, and (in assist mode) writes that report back to `planning/`. It never modifies
 * the design document and never loads a tool.
 */

export interface PlanAuditToolContext {
  projectPath: string;
  agentId?: string;
  tools: PlanToolCandidate[];
  service: PlanAuditRunner;
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
}

export async function executePlanAuditTool(
  args: Record<string, unknown>,
  context: PlanAuditToolContext,
): Promise<string> {
  if (context.agentId !== 'researcher') {
    return failure('not_authorized', 'plan-audit is only available to the researcher role');
  }
  const planPath = String(args.path ?? '').trim();
  if (!planPath) return failure('bad_response', 'plan-audit requires path=<design document>');

  let content: string;
  try {
    content = readProjectFile(context.projectPath, planPath).content;
  } catch (error) {
    return failure('bad_response', error instanceof Error ? error.message : String(error));
  }

  const parsed = parsePlanSteps(content);
  if (!parsed.ok) return failure(parsed.reason, parsed.message);

  let result: PlanAuditResult;
  try {
    result = await context.service.runPlanAudit({
      requestId: context.requestId,
      runId: context.runId,
      sessionId: context.sessionId,
      rolePromptVersion: context.rolePromptVersion,
      planPath: normalizeRelative(context.projectPath, planPath),
      planHash: hash(content),
      steps: parsed.steps,
      tools: context.tools,
    });
  } catch (error) {
    return failure('bad_response', error instanceof Error ? error.message : String(error));
  }
  if (!result.ok) return failure(result.reason, result.message ?? 'plan-audit failed');

  const { report } = result;
  const reportPath = report.mode === 'assist'
    ? `planning/plan-audit-${slugFor(planPath)}.md`
    : undefined;
  if (reportPath) {
    try {
      writeProjectFile(context.projectPath, reportPath, result.markdown);
    } catch (error) {
      return failure('bad_response', `report write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return JSON.stringify({
    ok: true,
    action: 'plan-audit',
    ...(reportPath ? { reportPath } : { shadow: true }),
    designPath: normalizeRelative(context.projectPath, planPath),
    summary: report.summary,
    opportunities: report.steps.filter(isOpportunity).slice(0, 10).map((step) => ({
      stepId: step.stepId,
      type: step.opportunity,
      current: step.currentToolId ?? null,
      recommended: step.recommendedToolId ?? null,
      confidence: step.confidence,
      reason: step.reasons.join('; '),
    })),
    biod: {
      mode: report.mode,
      modelVersion: report.modelVersion,
      policyVersion: report.policyVersion,
      latencyMs: report.latencyMs,
    },
    ...(report.fallback ? { warning: report.fallbackReason ?? 'partial audit' } : {}),
  });
}

function isOpportunity(step: StepAudit): boolean {
  return step.opportunity === 'better_tool' || step.opportunity === 'missing_tool';
}

function failure(reason: string, message: string): string {
  return JSON.stringify({ ok: false, action: 'plan-audit', reason, message });
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRelative(projectPath: string, value: string): string {
  return path.relative(path.resolve(projectPath), path.resolve(projectPath, value)).replace(/\\/g, '/');
}

function slugFor(planPath: string): string {
  const base = path.basename(planPath).replace(/\.md$/i, '');
  const raw = base.startsWith('experiment-design-') ? base.slice('experiment-design-'.length) : base;
  return raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'plan';
}
