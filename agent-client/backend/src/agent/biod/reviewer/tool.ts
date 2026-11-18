import path from 'node:path';
import {
  readProjectFile,
  projectRelativePath,
  resolveProjectPath,
  writeProjectFile,
} from '../../config/project_files.js';
import type {
  IssueAuditResult,
  IssueAuditRunner,
  IssueAuditServiceInput,
  ReviewerRole,
} from './contracts.js';

/**
 * `toollibrary action="issue-audit"` handler.
 *
 * It reads the reviewed document and the Reviewer's issue matrix, asks biod for a triage
 * report, and writes the report under `review/` in assist mode. It never edits the review
 * or the issue matrix, never creates issues, and never loads a tool.
 */
export interface IssueAuditToolContext {
  projectPath: string;
  agentId?: string;
  service: IssueAuditRunner;
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
}

export async function executeIssueAuditTool(
  args: Record<string, unknown>,
  context: IssueAuditToolContext,
): Promise<string> {
  if (context.agentId !== 'reviewer') {
    return failure('not_authorized', 'issue-audit is only available to the reviewer role');
  }

  const documentPath = stringArg(args.path) || 'manuscript/manuscript.md';
  const issuesPath = stringArg(args.issuesPath) || 'review/issues.csv';
  if (!documentPath.toLowerCase().endsWith('.md')) {
    return failure(
      'unsupported_manuscript_format',
      'issue-audit v1 accepts Markdown (.md) only; export the reviewed document to Markdown first',
    );
  }

  let documentContent: string;
  try {
    documentContent = readText(context.projectPath, documentPath);
  } catch (error) {
    return failure('missing_manuscript', error instanceof Error ? error.message : String(error));
  }

  let issuesContent: string;
  try {
    issuesContent = readText(context.projectPath, issuesPath);
  } catch (error) {
    return failure('missing_issues', error instanceof Error ? error.message : String(error));
  }

  let result: IssueAuditResult;
  try {
    result = await context.service.runIssueAudit({
      requestId: context.requestId,
      runId: context.runId,
      sessionId: context.sessionId,
      rolePromptVersion: context.rolePromptVersion,
      documentPath: normalizeRelative(context.projectPath, documentPath),
      issuesPath: normalizeRelative(context.projectPath, issuesPath),
      documentContent,
      issuesContent,
    });
  } catch (error) {
    return failure('bad_response', error instanceof Error ? error.message : String(error));
  }
  if (!result.ok) return failure(result.reason, result.message ?? 'issue-audit failed');

  const { report } = result;
  const reportPath = report.mode === 'assist'
    ? `review/issue-audit-${slugFor(documentPath)}.md`
    : undefined;
  if (reportPath) {
    try {
      writeProjectFile(context.projectPath, reportPath, result.markdown);
    } catch (error) {
      return failure('bad_response', `report write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const queueLimit = 10;
  return JSON.stringify({
    ok: true,
    action: 'issue-audit',
    ...(reportPath ? { reportPath } : { shadow: true }),
    documentPath: report.documentPath,
    issuesPath: report.issuesPath,
    summary: report.summary,
    queue: report.queue.slice(0, queueLimit).map((entry) => ({
      issueId: entry.issueId,
      priority: entry.priority,
      premiseStatus: entry.premiseStatus,
      owner: entry.owner,
      ...(entry.rank !== undefined ? { rank: entry.rank } : {}),
      why: entry.why,
    })),
    ownerTally: ownerTally(report.issues.map((issue) => issue.owner.owner)),
    biod: {
      mode: report.mode,
      modelVersion: report.modelVersion,
      policyVersion: report.policyVersion,
      latencyMs: report.latencyMs,
    },
    ...(report.fallback ? { warning: report.fallbackReason ?? 'partial audit' } : {}),
    ...(report.summary.deferred ? { warningDeferred: `${report.summary.deferred} issue(s) deferred by maxScoredIssues` } : {}),
  });
}

function ownerTally(owners: ReviewerRole[]): Record<ReviewerRole, number> {
  const tally: Record<ReviewerRole, number> = { searcher: 0, researcher: 0, writer: 0, reviewer: 0, pi: 0 };
  for (const owner of owners) tally[owner] += 1;
  return tally;
}

/** `readProjectFile` base64-encodes extensions it does not classify as text. */
function readText(projectPath: string, relativePath: string): string {
  const file = readProjectFile(projectPath, relativePath);
  return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

function stringArg(value: unknown): string {
  return String(value ?? '').replace(/\\/g, '/').trim();
}

function normalizeRelative(projectPath: string, value: string): string {
  return projectRelativePath(projectPath, resolveProjectPath(projectPath, value));
}

function slugFor(documentPath: string): string {
  const base = path.basename(documentPath).replace(/\.md$/i, '');
  return (base === 'manuscript' ? 'manuscript' : base).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'manuscript';
}

function failure(reason: string, message: string): string {
  return JSON.stringify({ ok: false, action: 'issue-audit', reason, message });
}
