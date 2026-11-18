import type { IssueAudit, IssueAuditReport, IssuePriority } from './contracts.js';

/**
 * Render the human-facing V1 report.
 *
 * The report is a triage aid for issues the Reviewer already wrote. It deliberately avoids
 * severity grades and accept/reject language, and it labels P0/P1/P2 as check priorities.
 */
export function renderIssueAuditReport(report: IssueAuditReport): string {
  const lines: string[] = [];
  lines.push(`# Issue Triage Audit · ${slugFromPath(report.documentPath)}`, '');
  lines.push(`> manuscript: ${report.documentPath}`);
  lines.push(`> issues: ${report.issuesPath}`);
  lines.push(`> generated: ${new Date().toISOString()}`);
  lines.push(`> mode: ${report.mode}`);
  lines.push(`> model: ${report.modelVersion}`);
  lines.push(`> policy: ${report.policyVersion}`);
  lines.push(`> document hash: ${report.documentHash}`);
  lines.push(`> issues hash: ${report.issuesHash}`, '');
  lines.push(
    '> Bounded check on the factual premises and ownership of the issues you already wrote.',
  );
  lines.push('> It does not create issues, assign severity, or decide accept/reject.');
  lines.push('> **P0/P1/P2 are check priorities, not issue severities.**', '');

  lines.push('## Summary', '');
  lines.push('| issues | premises | P0 | P1 | P2 | holds | contradicted | unresolved | no_premise | anchors missing | duplicates | owner undecided | deferred |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  lines.push(
    `| ${report.summary.totalIssues} | ${report.summary.totalPremises} | ${report.summary.p0} | ${report.summary.p1} | ${report.summary.p2} | ${report.summary.premisesHold} | ${report.summary.premiseContradicted} | ${report.summary.premiseUnresolved} | ${report.summary.noPremise} | ${report.summary.anchorsMissing} | ${report.summary.duplicates} | ${report.summary.ownerUndecided} | ${report.summary.deferred} |`,
  );
  lines.push('');

  appendPrioritySection(lines, report, 'P0', 'P0 · premise contradicted — re-read before acting');
  appendPrioritySection(lines, report, 'P1', 'P1 · premise unresolved / ownership unclear');
  appendPrioritySection(lines, report, 'P2', 'P2 · informational');

  lines.push('## Triage queue', '');
  lines.push('> Relative order only; it is not a severity grade. Ties keep the CSV order.');
  lines.push('');
  lines.push('| # | issue | claimed severity | premise status | owner | why |');
  lines.push('|---|---|---|---|---|---|');
  for (const [index, entry] of report.queue.entries()) {
    const issue = report.issues.find((candidate) => candidate.issueId === entry.issueId);
    lines.push(
      `| ${entry.rank ?? index + 1} | ${escapeCell(entry.issueId)} | ${escapeCell(issue?.severityClaim ?? '')} | ${escapeCell(entry.premiseStatus)} | ${escapeCell(entry.owner)} | ${escapeCell(entry.why)} |`,
    );
  }
  if (!report.queue.length) lines.push('| - | none | - | - | - | - |');
  lines.push('');

  lines.push('## Issues', '');
  for (const issue of report.issues) {
    appendIssue(lines, issue);
  }

  lines.push('## Deterministic checks', '');
  lines.push(`- anchors missing: ${report.summary.anchorsMissing}`);
  lines.push(`- locator missing: ${report.summary.locatorMissing}`);
  lines.push(`- sections missing: ${report.summary.sectionsMissing}`);
  lines.push(`- absence premises: ${report.summary.absenceChecks} (${report.summary.absenceHits} found a hit)`);
  lines.push(`- duplicate issues: ${report.summary.duplicates}${duplicatePairs(report).length ? ` (${duplicatePairs(report).join('; ')})` : ''}`);
  lines.push(`- pairwise: ${report.pairwise.comparisons} comparison(s) over ${report.pairwise.candidates} candidate(s)${report.pairwise.truncated ? '; cap reached' : ''}`);
  lines.push('');

  lines.push('## Not judged', '');
  lines.push('- whether an issue is Blocking / Important / Suggestion; biod never assigns a severity grade');
  lines.push('- whether the issue should exist at all, or whether it is novel');
  lines.push('- issue coverage: problems not written into `issues.csv` are not audited');
  lines.push('- accept/reject or any editorial recommendation');
  lines.push('- statistics re-analysis, literature search, or new experiments');
  lines.push('');

  lines.push('## Method & limits', '');
  lines.push('- per-issue/per-premise check; passages are extracted from the document by code');
  lines.push('- premises are Reviewer-authored; biod only checks them against the extracted passage');
  lines.push('- absence checks search this document only; a miss is not proof that the content does not exist');
  lines.push('- pairwise queue is a relative order, not a severity grade');
  lines.push(`- scorer: ${report.modelVersion}; no training in this build`);
  lines.push('- deferred issues are listed, not silently dropped');
  lines.push('- the report only suggests actions; the Reviewer decides what to change');
  lines.push('');
  return lines.join('\n');
}

function appendIssue(lines: string[], issue: IssueAudit): void {
  lines.push(`### ${issue.issueId} · ${issue.section} · ${issue.issueType} · claimed ${issue.severityClaim}`, '');
  lines.push(`- issue: ${oneLine(issue.issueText)}`);
  lines.push(`- premise status: ${issue.premiseStatus}`);
  if (issue.finding === 'deferred') {
    lines.push('- audit: deferred (not audited in this run)');
    lines.push('');
    return;
  }
  if (issue.premises.length) {
    lines.push('- premises:');
    for (const premise of issue.premises) {
      lines.push(
        `  - \`${premise.premiseId}\` ${premise.kind} "${oneLine(clip(premise.premiseText, 160))}" → \`${premise.verdict}\` (${premise.confidence.toFixed(2)})`,
      );
      if (premise.kind === 'absence') {
        lines.push(`    - check: ${premise.reasons.join('; ')}`);
      } else if (premise.passage) {
        const where = premise.passageSection ? ` (${premise.passageSection})` : '';
        lines.push(`    - passage${where}: ${oneLine(clip(premise.passage, 300))}`);
        if (premise.passage2) lines.push(`    - passage B: ${oneLine(clip(premise.passage2, 300))}`);
        lines.push(`    - why: ${premise.reasons.join('; ')}`);
      } else {
        lines.push(`    - why: ${premise.reasons.join('; ')}`);
      }
      if (premise.flags.length) lines.push(`    - flags: ${premise.flags.join(', ')}`);
    }
  }
  lines.push(
    `- owner: ${issue.owner.owner} (${issue.owner.confidence.toFixed(2)})${issue.owner.alternatives.length ? `; alternatives: ${issue.owner.alternatives.map((entry) => `${entry.role} ${entry.score.toFixed(2)}`).join(', ')}` : ''}${issue.ownerSuggested ? `; reviewer suggested: ${issue.ownerSuggested}` : ''}`,
  );
  if (issue.owner.undecided) lines.push('- owner route: undecided (margin below threshold); suggest PI dispatch');
  if (issue.actions.length) lines.push(`- action: ${issue.actions.join(' / ')}`);
  if (issue.flags.length) lines.push(`- flags: ${issue.flags.join(', ')}`);
  if (issue.rank !== undefined) lines.push(`- pairwise rank: ${issue.rank} (wins ${issue.pairwiseWins ?? 0})`);
  lines.push(`- check priority: ${issue.priority}`);
  if (issue.reasons.length) lines.push(`- why: ${issue.reasons.join('; ')}`);
  if (issue.fallback) lines.push('- fallback: one or more premises could not be scored');
  lines.push('');
}

function appendPrioritySection(
  lines: string[],
  report: IssueAuditReport,
  priority: IssuePriority,
  title: string,
): void {
  const issues = report.issues.filter((issue) => issue.priority === priority);
  lines.push(`## ${title}`, '');
  if (!issues.length) {
    lines.push('None.', '');
    return;
  }
  lines.push('| issue | section | claimed severity | premise status | why | action |');
  lines.push('|---|---|---|---|---|---|');
  for (const issue of issues) {
    lines.push(
      `| ${escapeCell(issue.issueId)} | ${escapeCell(issue.section)} | ${escapeCell(issue.severityClaim)} | ${escapeCell(issue.premiseStatus)} | ${escapeCell(issue.reasons[0] ?? '')} | ${escapeCell(issue.actions.join(', '))} |`,
    );
  }
  lines.push('');
}

function duplicatePairs(report: IssueAuditReport): string[] {
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const issue of report.issues) {
    for (const duplicate of issue.duplicates) {
      const key = [issue.issueId, duplicate].sort().join('≈');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(key);
    }
  }
  return pairs;
}

function slugFromPath(value: string): string {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? 'document';
  return base.replace(/\.md$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
}

function clip(value: string, maxChars: number): string {
  const text = String(value ?? '').trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function oneLine(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeCell(value: string): string {
  return oneLine(value).replace(/\|/g, '\\|');
}
