import fs from 'node:fs';
import path from 'node:path';
import {
  isInsideProject,
  projectRelativePath,
  readProjectFile,
  resolveProjectPath,
  writeProjectFile,
} from '../../config/project_files.js';
import type {
  ManuscriptAuditResult,
  ManuscriptAuditRunner,
  ManuscriptAuditServiceInput,
} from './contracts.js';

/**
 * `toollibrary action="manuscript-audit"` handler.
 *
 * It reads the draft, matrix, and optional BibTeX file, asks biod for a report, and writes
 * the report under `manuscript/` in assist mode. It never edits the draft or the matrix and
 * never loads a tool.
 */
export interface ManuscriptAuditToolContext {
  projectPath: string;
  agentId?: string;
  service: ManuscriptAuditRunner;
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
}

export async function executeManuscriptAuditTool(
  args: Record<string, unknown>,
  context: ManuscriptAuditToolContext,
): Promise<string> {
  if (context.agentId !== 'writer') {
    return failure('not_authorized', 'manuscript-audit is only available to the writer role');
  }

  const manuscriptPath = stringArg(args.path) || 'manuscript/manuscript.md';
  const matrixPath = stringArg(args.matrixPath) || 'manuscript/claim-evidence.csv';
  const referencesPath = stringArg(args.referencesPath) || 'manuscript/references.bib';
  if (!manuscriptPath.toLowerCase().endsWith('.md')) {
    return failure('unsupported_manuscript_format', 'manuscript-audit v1 accepts Markdown (.md) only; export the draft to manuscript.md first');
  }

  let manuscriptContent: string;
  try {
    manuscriptContent = readText(context.projectPath, manuscriptPath);
  } catch (error) {
    return failure('missing_manuscript', error instanceof Error ? error.message : String(error));
  }

  let matrixContent: string;
  try {
    matrixContent = readText(context.projectPath, matrixPath);
  } catch (error) {
    return failure('missing_claim_matrix', error instanceof Error ? error.message : String(error));
  }

  const referencesContent = readOptional(context.projectPath, referencesPath);
  const figures = listProjectDirectory(context.projectPath, 'manuscript/figures');
  const tables = listProjectDirectory(context.projectPath, 'manuscript/tables');

  let result: ManuscriptAuditResult;
  try {
    result = await context.service.runManuscriptAudit({
      requestId: context.requestId,
      runId: context.runId,
      sessionId: context.sessionId,
      rolePromptVersion: context.rolePromptVersion,
      manuscriptPath: normalizeRelative(context.projectPath, manuscriptPath),
      matrixPath: normalizeRelative(context.projectPath, matrixPath),
      ...(referencesContent !== undefined ? { referencesPath: normalizeRelative(context.projectPath, referencesPath) } : {}),
      manuscriptContent,
      matrixContent,
      ...(referencesContent !== undefined ? { referencesContent } : {}),
      figures,
      tables,
    });
  } catch (error) {
    return failure('bad_response', error instanceof Error ? error.message : String(error));
  }
  if (!result.ok) return failure(result.reason, result.message ?? 'manuscript-audit failed');

  const { report } = result;
  const reportPath = report.mode === 'assist'
    ? `manuscript/audit-${slugFor(manuscriptPath)}.md`
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
    action: 'manuscript-audit',
    ...(reportPath ? { reportPath } : { shadow: true }),
    manuscriptPath: report.manuscriptPath,
    matrixPath: report.matrixPath,
    summary: report.summary,
    topIssues: report.claims
      .filter((claim) => claim.priority === 'P0' || claim.priority === 'P1')
      .slice(0, 10)
      .map((claim) => ({
        claimId: claim.claimId,
        section: claim.section,
        finding: claim.finding,
        priority: claim.priority,
        evidenceId: claim.edges[0]?.evidenceId ?? null,
        reason: claim.reasons[0] ?? '',
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

/**
 * Read a project file as UTF-8 text.
 *
 * `readProjectFile` returns base64 for extensions it does not classify as text; `.bib` is
 * one of them, and a BibTeX parser fed base64 silently sees zero entries. Decode here so a
 * citation precheck never fails for a file-format classification reason.
 */
function readText(projectPath: string, relativePath: string): string {
  const file = readProjectFile(projectPath, relativePath);
  return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

function readOptional(projectPath: string, relativePath: string): string | undefined {
  try {
    const absolute = resolveProjectPath(projectPath, relativePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return undefined;
    return readText(projectPath, relativePath);
  } catch {
    return undefined;
  }
}

function listProjectDirectory(projectPath: string, relativePath: string): string[] {
  try {
    const absolute = resolveProjectPath(projectPath, relativePath);
    if (!isInsideProject(projectPath, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      return [];
    }
    return fs.readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .slice(0, 200);
  } catch {
    return [];
  }
}

function stringArg(value: unknown): string {
  return String(value ?? '').replace(/\\/g, '/').trim();
}

function normalizeRelative(projectPath: string, value: string): string {
  return projectRelativePath(projectPath, resolveProjectPath(projectPath, value));
}

function slugFor(manuscriptPath: string): string {
  const base = path.basename(manuscriptPath).replace(/\.md$/i, '');
  return (base === 'manuscript' ? 'manuscript' : base).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'manuscript';
}

function failure(reason: string, message: string): string {
  return JSON.stringify({ ok: false, action: 'manuscript-audit', reason, message });
}
