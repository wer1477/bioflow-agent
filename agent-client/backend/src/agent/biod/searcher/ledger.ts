import fs from 'node:fs';
import path from 'node:path';
import type { HypothesisScreenReport } from './contracts.js';

/** Append-only ledger; diagnostics only, never allowed to fail a Searcher run. */
export interface HypothesisScreenLedger {
  append(record: HypothesisScreenRecord): void;
}

export interface HypothesisScreenRecord {
  ts: string;
  requestId: string;
  runId: string;
  role: 'searcher';
  decisionPoint: 's2.hypothesis-screen';
  mode: 'shadow' | 'assist';
  hypothesesPath: string;
  hypothesesHash: string;
  summary: HypothesisScreenReport['summary'];
  modelVersion: string;
  policyVersion: string;
  rendererVersion: string;
  latencyMs: number;
}

export class JsonlHypothesisScreenLedger implements HypothesisScreenLedger {
  constructor(private readonly file: string = '') {}

  append(record: HypothesisScreenRecord): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // The report is the product; a full disk must not take the Searcher run down.
    }
  }
}

export function toHypothesisScreenRecord(report: HypothesisScreenReport): HypothesisScreenRecord {
  return {
    ts: new Date().toISOString(),
    requestId: report.requestId,
    runId: report.runId,
    role: report.role,
    decisionPoint: report.decisionPoint,
    mode: report.mode,
    hypothesesPath: report.hypothesesPath,
    hypothesesHash: report.hypothesesHash,
    summary: report.summary,
    modelVersion: report.modelVersion,
    policyVersion: report.policyVersion,
    rendererVersion: report.rendererVersion,
    latencyMs: report.latencyMs,
  };
}
