import type { PremiseVerdict, SearcherArtifacts } from '../framework/contracts.js';
import type { SearcherScreenResult } from '../framework/screen.js';
import type { HypothesisScreenReport } from './contracts.js';

/**
 * Human-readable S2 report. It is intentionally a suggestion sheet: no "blocking", no
 * acceptance language, and no edits to the hypotheses it screens.
 */
export function renderHypothesisScreenReport(
  report: HypothesisScreenReport,
  artifacts: SearcherArtifacts,
  screen: SearcherScreenResult,
): string {
  const lines: string[] = [];
  lines.push(`# 假设筛选报告 · ${inline(report.hypothesesPath)}`);
  lines.push('');
  lines.push('> 这是 S2 假设筛选建议报告，不是 gate，不生成或修改假设；最终深审与取舍仍由 Searcher / PI 决定。');
  lines.push(`> mode: ${report.mode}`);
  lines.push(`> model: ${report.modelVersion}（未训练，启发式）`);
  lines.push(`> policy: ${report.policyVersion}`);
  lines.push(`> renderer: ${report.rendererVersion}`);
  lines.push(`> hypotheses hash: ${report.hypothesesHash.slice(0, 16)}`);
  if (report.rq) lines.push(`> RQ: ${inline(report.rq)}`);
  lines.push('');

  const summary = report.summary;
  lines.push('## Summary');
  lines.push('');
  lines.push('| cards | premises | evidence | supported | contradicted | unknown | fallback |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| ${summary.cards} | ${summary.premises} | ${summary.evidence} | ${summary.verdicts.supported} | ${summary.verdicts.contradicted} | ${summary.verdicts.unknown} | ${summary.fallback ? 'yes' : 'no'} |`);
  lines.push('');

  const cardById = new Map(artifacts.hypotheses.map((card) => [card.id, card]));
  const deferredById = new Map(summary.deferred.map((entry) => [entry.id, entry.reason]));
  const shortlist = new Set(summary.shortlist);

  lines.push('## 排序与短名单');
  lines.push('');
  if (!summary.ranked.length) {
    lines.push('没有产生排序（可能是 S2 关闭或输入不足）。');
  } else {
    lines.push('| rank | card | claim | gaps | premise 判定 | status |');
    lines.push('|---|---|---|---|---|---|');
    summary.ranked.forEach((id, index) => {
      const card = cardById.get(id);
      const counts = countVerdicts(screen.premiseVerdicts.filter((verdict) => verdict.hypId === id));
      const status = shortlist.has(id)
        ? 'shortlist'
        : deferredById.has(id)
          ? `deferred: ${inline(deferredById.get(id) ?? '')}`
          : 'ranked only';
      lines.push(`| ${index + 1} | ${inline(id)} | ${inline(clip(card?.claim ?? '', 90))} | ${inline(card?.gapIds.join(', ') ?? '')} | ${counts} | ${status} |`);
    });
  }
  lines.push('');

  lines.push('## 前提判定');
  lines.push('');
  if (!screen.premiseVerdicts.length) {
    lines.push('没有 premise 判定（S2.P 未运行或没有 premise）。');
  } else {
    lines.push('| card | premise | verdict | confidence | evidence | note |');
    lines.push('|---|---|---|---|---|---|');
    for (const verdict of screen.premiseVerdicts) {
      const card = cardById.get(verdict.hypId);
      const premise = card?.premises?.find((item) => item.pid === verdict.pid);
      const label = premise ? `${verdict.pid}: ${clip(premise.text, 60)}` : `${verdict.pid}: ${clip(card?.claim ?? '', 60)}`;
      lines.push(`| ${inline(verdict.hypId)} | ${inline(label)} | ${verdict.verdict} | ${verdict.confidence.toFixed(2)} | ${inline(verdict.evidenceId || 'none')} | ${inline(verdict.reasonCode ?? '')} |`);
    }
  }
  lines.push('');

  lines.push('## 延期（deferred）');
  lines.push('');
  if (!summary.deferred.length) {
    lines.push('无。');
  } else {
    lines.push('| card | reason |');
    lines.push('|---|---|');
    for (const entry of summary.deferred) lines.push(`| ${inline(entry.id)} | ${inline(entry.reason)} |`);
  }
  lines.push('');

  lines.push('## 深审建议（S3 trigger）');
  lines.push('');
  lines.push(summary.deepReview.length ? summary.deepReview.map((id) => `- ${inline(id)}`).join('\n') : 'S3 未启用或无触发；按原计划深审。');
  lines.push('');

  lines.push('## 多样性守卫（S5）');
  lines.push('');
  lines.push(summary.diversityFlags.length ? summary.diversityFlags.map((flag) => `- ${inline(flag)}`).join('\n') : 'S5 未启用或未触发。');
  if (summary.exploration.length) {
    lines.push('');
    lines.push(`探索抽样：${summary.exploration.map((id) => inline(id)).join(', ')}`);
  }
  lines.push('');

  lines.push('## 方法与时界');
  lines.push('');
  lines.push('- 输入是 Searcher 维护的结构化 `hypotheses.yaml`；本报告不生成假设、不补证据、不修改文件。');
  lines.push('- 当前 scorer 是启发式规则，未训练 S2 head；`contradicted` 只表示“给定证据片段下 premise 被否定”，不是最终学术判断。');
  lines.push('- `shortlist` / `ranked` 只影响深审顺序；`deferred` 不是删除，`unknown` 仍有资格。');
  lines.push('- `no_issue_found` 不存在于此报告；biod 不判 novelty / impact / 最终价值。');
  if (summary.fallback) lines.push('- 本次存在 fallback 决策；低置信一律回落到原排序。');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function countVerdicts(verdicts: PremiseVerdict[]): string {
  const counts = { supported: 0, contradicted: 0, unknown: 0 };
  for (const verdict of verdicts) counts[verdict.verdict] += 1;
  return `S${counts.supported}/C${counts.contradicted}/U${counts.unknown}`;
}

function clip(value: string, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function inline(value: string): string {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}
