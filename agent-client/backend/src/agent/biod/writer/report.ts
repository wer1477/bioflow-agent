import type { ManuscriptAuditReport, Priority } from './contracts.js';

/** Render the human-facing W1 report. The report is a risk list, not an editorial verdict. */
export function renderManuscriptAuditReport(report: ManuscriptAuditReport): string {
  const lines: string[] = [];
  lines.push(`# Manuscript Evidence Audit · ${slugFromPath(report.manuscriptPath)}`, '');
  lines.push(`> manuscript: ${report.manuscriptPath}`);
  lines.push(`> matrix: ${report.matrixPath}`);
  if (report.referencesPath) lines.push(`> references: ${report.referencesPath}`);
  lines.push(`> generated: ${new Date().toISOString()}`);
  lines.push(`> mode: ${report.mode}`);
  lines.push(`> model: ${report.modelVersion}`);
  lines.push(`> policy: ${report.policyVersion}`);
  lines.push(`> manuscript hash: ${report.manuscriptHash}`);
  lines.push(`> matrix hash: ${report.matrixHash}`, '');
  lines.push('> This is a post-draft evidence-chain risk list, not a peer-review decision. It does not edit the manuscript, and `no_issue_found` does not prove a claim is true.', '');

  lines.push('## Summary', '');
  lines.push('| claims | edges | P0 | P1 | P2 | no_issue | check_support | mismatch | overclaim | missing | needs_data | unverifiable | stale |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  lines.push(
    `| ${report.summary.totalClaims} | ${report.summary.totalEdges} | ${report.summary.p0} | ${report.summary.p1} | ${report.summary.p2} | ${report.summary.no_issue_found} | ${report.summary.check_support} | ${report.summary.support_mismatch} | ${report.summary.overclaim} | ${report.summary.missing_evidence} | ${report.summary.needs_data} | ${report.summary.unverifiable} | ${report.summary.stale_claim} |`,
  );
  lines.push('');

  appendPrioritySection(lines, report, 'P0', 'P0 · check first');
  appendPrioritySection(lines, report, 'P1', 'P1 · recommended check');
  appendPrioritySection(lines, report, 'P2', 'P2 · informational');

  lines.push('## Claims', '');
  for (const claim of report.claims) {
    lines.push(`### ${claim.claimId} · ${claim.section} · ${claim.claimType}`, '');
    lines.push(`- claim: ${oneLine(claim.claimText)}`);
    lines.push(`- writer status: ${claim.writerStatus}`);
    lines.push(`- audit: ${claim.finding}${claim.priority === 'none' ? '' : ` (${claim.priority})`}; confidence ${claim.confidence.toFixed(2)}`);
    if (claim.reasons.length) lines.push(`- why: ${claim.reasons.join('; ')}`);
    if (claim.flags.length) lines.push(`- flags: ${claim.flags.join(', ')}`);
    if (claim.actions.length) lines.push(`- action: ${claim.actions.join(' / ')}`);
    if (claim.edges.length) {
      lines.push('- evidence:');
      for (const edge of claim.edges) {
        lines.push(
          `  - \`${edge.evidenceId}\` ${edge.evidenceType} \`${oneLine(edge.locator)}\` · relation \`${edge.relation}\` · confidence ${edge.confidence.toFixed(2)}`,
        );
        if (edge.reasons.length) lines.push(`    - why: ${edge.reasons.join('; ')}`);
        if (edge.overclaim.length) lines.push(`    - overclaim: ${edge.overclaim.join(', ')}`);
        if (edge.precheck.issues.length) {
          lines.push(`    - precheck: ${edge.precheck.issues.map((issue) => `${issue.code}(${issue.severity})`).join(', ')}`);
        }
      }
    }
    lines.push('');
  }

  lines.push('## Precheck', '');
  lines.push(`- missing citation keys: ${report.precheck.citationKeysMissing}`);
  lines.push(`- orphan bib entries: ${report.precheck.orphanCitations}`);
  lines.push(`- figure refs missing: ${report.precheck.figureRefsMissing}`);
  lines.push(`- table refs missing: ${report.precheck.tableRefsMissing}`);
  lines.push(`- stale claims: ${report.precheck.staleClaims}`);
  lines.push(`- citation style unsupported: ${report.precheck.styleUnsupported ? 'yes (numeric citations)' : 'no'}`);
  lines.push('');

  lines.push('## Not judged', '');
  lines.push('- novelty, journal fit, prose quality, or statistical validity');
  lines.push('- paragraph-level argument validity or rhetorical strength');
  lines.push('- full-text entailment; only the supplied claim/quote/locator are checked');
  lines.push('- raw data reanalysis or a new literature search');
  lines.push('');

  lines.push('## Method & limits', '');
  lines.push('- per-claim/per-evidence-edge audit; the whole manuscript is never placed in one model state');
  lines.push('- deterministic precheck runs before any semantic scoring');
  lines.push(`- scorer: ${report.modelVersion}; no training in this build`);
  lines.push('- matrix coverage is Writer-maintained; claims absent from the matrix are not audited');
  lines.push('- the report only suggests actions; Writer decides what to change');
  lines.push('');
  return lines.join('\n');
}

function appendPrioritySection(
  lines: string[],
  report: ManuscriptAuditReport,
  priority: Priority,
  title: string,
): void {
  const claims = report.claims.filter((claim) => claim.priority === priority);
  lines.push(`## ${title}`, '');
  if (!claims.length) {
    lines.push('None.', '');
    return;
  }
  lines.push('| claim | section | finding | evidence | action |');
  lines.push('|---|---|---|---|---|');
  for (const claim of claims) {
    lines.push(
      `| ${escapeCell(claim.claimId)} | ${escapeCell(claim.section)} | ${escapeCell(claim.finding)} | ${escapeCell(claim.edges.map((edge) => edge.evidenceId).join(', ') || 'none')} | ${escapeCell(claim.actions.join(', '))} |`,
    );
  }
  lines.push('');
}

function slugFromPath(value: string): string {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? 'manuscript';
  return base.replace(/\.md$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'manuscript';
}

function oneLine(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeCell(value: string): string {
  return oneLine(value).replace(/\|/g, '\\|');
}
