import type { PlanAuditReport, StepAudit } from './contracts.js';

/**
 * Human-readable report. It is intentionally a suggestion sheet: no "blocking", no
 * approval language, and no edits to the design document it audits.
 */

export function renderPlanAuditReport(report: PlanAuditReport): string {
  const lines: string[] = [];
  lines.push(`# Plan Audit · ${inline(report.planPath)}`);
  lines.push('');
  lines.push('> 这是工具机会核查报告，不是 gate，也不是审批。改不改方案由 Researcher 决定。');
  lines.push(`> mode: ${report.mode}`);
  lines.push(`> model: ${report.modelVersion}`);
  lines.push(`> policy: ${report.policyVersion}`);
  lines.push(`> renderer: ${report.rendererVersion}`);
  lines.push(`> plan hash: ${report.planHash.slice(0, 16)}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| total | better_tool | missing_tool | keep_current | no_tool | uncertain | fallback |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| ${report.summary.total} | ${report.summary.better_tool} | ${report.summary.missing_tool} | ${report.summary.keep_current} | ${report.summary.no_tool} | ${report.summary.uncertain} | ${report.summary.fallback} |`);
  lines.push('');

  const opportunities = report.steps.filter((step) => step.opportunity === 'better_tool' || step.opportunity === 'missing_tool');
  lines.push('## Opportunities');
  lines.push('');
  if (!opportunities.length) {
    lines.push('没有发现高于阈值的工具机会。');
  } else {
    for (const step of opportunities) lines.push(...renderOpportunity(step));
  }
  lines.push('');

  const unchanged = report.steps.filter((step) => step.opportunity === 'keep_current' || step.opportunity === 'no_tool');
  lines.push('## Keep current / NO_TOOL');
  lines.push('');
  if (!unchanged.length) {
    lines.push('无。');
  } else {
    lines.push('| step | current | opportunity | reason |');
    lines.push('|---|---|---|---|');
    for (const step of unchanged) {
      lines.push(`| ${inline(step.stepId)} | ${inline(step.currentToolId ?? 'none')} | ${step.opportunity} | ${inline(step.reasons.join('; '))} |`);
    }
  }
  lines.push('');

  const uncertain = report.steps.filter((step) => step.opportunity === 'uncertain');
  lines.push('## Not judged');
  lines.push('');
  if (!uncertain.length) {
    lines.push('无。');
  } else {
    lines.push('| step | reason |');
    lines.push('|---|---|');
    for (const step of uncertain) {
      lines.push(`| ${inline(step.stepId)} | ${inline(step.reasons.join('; ') || 'uncertain')} |`);
    }
  }
  lines.push('');

  lines.push('## Method & limits');
  lines.push('');
  lines.push('- 候选：Researcher 角色绑定的 skills / MCP tools；不含 knowledgebase 条目和 core tools。');
  lines.push('- 当前工具只作为候选之一或 baseline；报告不判断“工具是否正确”，只比较是否有更合适的替代。');
  lines.push('- 打分来自 heuristic 或 v0 tool head；尚未训练 plan-audit head。低置信一律标 uncertain。');
  lines.push('- 工具机会是建议：不修改 design/SAP，不自动 toolload，不阻断执行。');
  if (report.fallback) {
    lines.push(`- 本次存在未判定步骤：${report.fallbackReason ?? 'fallback'}。`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function renderOpportunity(step: StepAudit): string[] {
  const lines: string[] = [];
  lines.push(`### ${inline(step.stepId)} · ${inline(step.goal)}`);
  lines.push('');
  lines.push(`- current: ${inline(step.currentToolId ?? 'none')} (${step.currentToolKind})`);
  lines.push(`- recommended: ${inline(step.recommendedToolId ?? 'none')}`);
  lines.push(`- type: ${step.opportunity}`);
  lines.push(`- confidence: ${step.confidence}`);
  if (step.evidence) lines.push(`- evidence: "${inline(step.evidence)}"`);
  if (step.benefit.length) lines.push(`- benefit: ${step.benefit.join(', ')}`);
  lines.push(`- why: ${inline(step.reasons.join('; '))}`);
  if (step.flags.length) lines.push(`- flags: ${step.flags.join(', ')}`);
  lines.push('');
  return lines;
}

function inline(value: string): string {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}
