import fs from 'node:fs';
import path from 'node:path';
import type { PlanAuditRecord, PlanAuditReport, PlanAuditTrace } from './contracts.js';

/** Append-only audit ledger; diagnostics only, never allowed to fail a decision. */
export interface PlanAuditLedger {
  append(record: PlanAuditRecord): void;
}

export class JsonlPlanAuditLedger implements PlanAuditLedger {
  constructor(private readonly file: string = '') {}

  append(record: PlanAuditRecord): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // The report is the product; a full disk must not take the Researcher run down.
    }
  }
}

export function toPlanAuditRecord(report: PlanAuditReport, trace: PlanAuditTrace): PlanAuditRecord {
  return {
    ts: new Date().toISOString(),
    requestId: report.requestId,
    runId: report.runId,
    role: report.role,
    decisionPoint: report.decisionPoint,
    mode: report.mode,
    planPath: report.planPath,
    planHash: report.planHash,
    stepCount: report.steps.length,
    modelVersion: report.modelVersion,
    policyVersion: report.policyVersion,
    rendererVersion: report.rendererVersion,
    steps: trace.steps,
    summary: report.summary,
    fallback: report.fallback,
    ...(report.fallbackReason ? { fallbackReason: report.fallbackReason } : {}),
    latencyMs: report.latencyMs,
  };
}
