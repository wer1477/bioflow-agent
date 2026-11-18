import type { ArtifactIssue } from '../framework/artifacts.js';
import type { SearcherArtifacts } from '../framework/contracts.js';
import type { SearcherScreenResult } from '../framework/screen.js';

export type HypothesisScreenMode = 'shadow' | 'assist';

export type HypothesisScreenFailureReason =
  | 'disabled'
  | 'missing_hypotheses'
  | 'empty_hypotheses'
  | 'invalid_hypotheses'
  | 'no_cards'
  | 'not_authorized'
  | 'bad_response';

export interface HypothesisScreenSummary {
  cards: number;
  premises: number;
  evidence: number;
  verdicts: { supported: number; contradicted: number; unknown: number };
  shortlist: string[];
  ranked: string[];
  deferred: Array<{ id: string; reason: string }>;
  exploration: string[];
  deepReview: string[];
  diversityFlags: string[];
  fallback: boolean;
}

export interface HypothesisScreenReport {
  requestId: string;
  runId: string;
  role: 'searcher';
  decisionPoint: 's2.hypothesis-screen';
  mode: HypothesisScreenMode;
  hypothesesPath: string;
  hypothesesHash: string;
  rq?: string;
  summary: HypothesisScreenSummary;
  modelVersion: string;
  policyVersion: string;
  rendererVersion: string;
  latencyMs: number;
}

export interface HypothesisScreenServiceInput {
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
  hypothesesPath: string;
  hypothesesHash: string;
  artifacts: SearcherArtifacts;
}

export interface HypothesisScreenSuccess {
  ok: true;
  report: HypothesisScreenReport;
  markdown: string;
  screen: SearcherScreenResult;
}

export interface HypothesisScreenFailure {
  ok: false;
  reason: HypothesisScreenFailureReason;
  message: string;
  issues?: ArtifactIssue[];
}

export type HypothesisScreenResult = HypothesisScreenSuccess | HypothesisScreenFailure;

export interface HypothesisScreenRunner {
  runHypothesisScreen(input: HypothesisScreenServiceInput): Promise<HypothesisScreenResult>;
}
