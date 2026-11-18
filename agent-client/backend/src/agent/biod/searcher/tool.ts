import path from 'node:path';
import { readProjectFile, writeProjectFile } from '../../config/project_files.js';
import type { HypothesisScreenRunner } from './contracts.js';
import {
  HYPOTHESIS_SCREEN_DEFAULT_PATH,
  HYPOTHESIS_SCREEN_DECISION_POINT,
  HYPOTHESIS_SCREEN_REPORT_ROOT,
  HYPOTHESIS_SCREEN_TOOL_ACTION,
} from './registry.js';
import { hashHypotheses, parseHypothesesYaml } from './yaml.js';

/**
 * `toollibrary action="hypothesis-screen"` handler.
 *
 * It reads the Searcher's structured `hypotheses.yaml`, asks the S2 framework for a screen,
 * and (in assist mode) writes the report under `research/`. It never generates, edits, or
 * deletes hypotheses, and never loads a tool.
 */
export interface HypothesisScreenToolContext {
  projectPath: string;
  agentId?: string;
  service: HypothesisScreenRunner;
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
}

export async function executeHypothesisScreenTool(
  args: Record<string, unknown>,
  context: HypothesisScreenToolContext,
): Promise<string> {
  if (context.agentId !== 'searcher') {
    return failure('not_authorized', 'hypothesis-screen is only available to the searcher role');
  }

  const hypothesesPath = stringArg(args.path) || HYPOTHESIS_SCREEN_DEFAULT_PATH;
  if (!/\.ya?ml$/i.test(hypothesesPath)) {
    return failure('invalid_hypotheses', 'hypothesis-screen accepts a .yaml or .yml hypotheses file');
  }

  let content: string;
  try {
    content = readText(context.projectPath, hypothesesPath);
  } catch (error) {
    return failure('missing_hypotheses', error instanceof Error ? error.message : String(error));
  }

  const parsed = parseHypothesesYaml(content);
  if (!parsed.ok) return failure(parsed.reason, parsed.message, parsed.issues);

  let result;
  try {
    result = await context.service.runHypothesisScreen({
      requestId: context.requestId,
      runId: context.runId,
      sessionId: context.sessionId,
      rolePromptVersion: context.rolePromptVersion,
      hypothesesPath: normalizeRelative(context.projectPath, hypothesesPath),
      hypothesesHash: hashHypotheses(content),
      artifacts: parsed.artifacts,
    });
  } catch (error) {
    return failure('bad_response', error instanceof Error ? error.message : String(error));
  }
  if (!result.ok) return failure(result.reason, result.message, result.issues);

  const { report } = result;
  const reportPath = report.mode === 'assist'
    ? `${HYPOTHESIS_SCREEN_REPORT_ROOT}/hypothesis-screen-${slugFor(hypothesesPath)}.md`
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
    action: HYPOTHESIS_SCREEN_TOOL_ACTION,
    ...(reportPath ? { reportPath } : { shadow: true }),
    hypothesesPath: report.hypothesesPath,
    summary: report.mode === 'assist'
      ? report.summary
      : {
          cards: report.summary.cards,
          premises: report.summary.premises,
          evidence: report.summary.evidence,
          verdicts: report.summary.verdicts,
          shortlistCount: report.summary.shortlist.length,
          deferredCount: report.summary.deferred.length,
          fallback: report.summary.fallback,
        },
    biod: {
      decisionPoint: HYPOTHESIS_SCREEN_DECISION_POINT,
      mode: report.mode,
      modelVersion: report.modelVersion,
      policyVersion: report.policyVersion,
      rendererVersion: report.rendererVersion,
      latencyMs: report.latencyMs,
    },
    ...(report.summary.fallback ? { warning: 'one or more S2 decisions fell back to the original order' } : {}),
  });
}

function failure(
  reason: string,
  message: string,
  issues?: Array<{ path: string; message: string }>,
): string {
  return JSON.stringify({
    ok: false,
    action: HYPOTHESIS_SCREEN_TOOL_ACTION,
    reason,
    message,
    ...(issues?.length ? { issues } : {}),
  });
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `readProjectFile` base64-encodes extensions it does not classify as text. */
function readText(projectPath: string, relativePath: string): string {
  const file = readProjectFile(projectPath, relativePath);
  return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

function normalizeRelative(projectPath: string, value: string): string {
  return path.relative(path.resolve(projectPath), path.resolve(projectPath, value)).replace(/\\/g, '/');
}

function slugFor(hypothesesPath: string): string {
  const base = path.basename(hypothesesPath).replace(/\.ya?ml$/i, '');
  return base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'hypotheses';
}
