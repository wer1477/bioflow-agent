import type { DecisionPointId, Mode, SearcherArtifacts, SearcherScreenResult } from '../framework/index.js';
import { screenSearcher } from '../framework/screen.js';
import type { BiodFramework } from '../framework/orchestrator.js';
import type { HypothesisScreenReport, HypothesisScreenSummary } from './contracts.js';
import {
  HYPOTHESIS_SCREEN_MODEL_VERSION,
  HYPOTHESIS_SCREEN_POLICY_VERSION,
  HYPOTHESIS_SCREEN_RENDERER_VERSION,
} from './registry.js';
import { renderHypothesisScreenReport } from './report.js';

export interface ScreenHypothesesContext {
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
  hypothesesPath: string;
  hypothesesHash: string;
  mode: 'shadow' | 'assist';
  modes: Partial<Record<DecisionPointId, Mode>>;
  framework: BiodFramework;
}

export interface ScreenHypothesesResult {
  report: HypothesisScreenReport;
  markdown: string;
  screen: SearcherScreenResult;
}

/**
 * Runs the S2 screen over already-validated artifacts and turns the decision stream into a
 * report. This is the only place that knows the report shape; the framework stays
 * model-free and callers stay free to ignore the shortlist.
 */
export async function screenHypotheses(
  artifacts: SearcherArtifacts,
  context: ScreenHypothesesContext,
): Promise<ScreenHypothesesResult> {
  const started = Date.now();
  const screen = await screenSearcher(artifacts, {
    mode: context.mode,
    modes: context.modes,
    runId: context.runId,
    sessionId: context.sessionId,
    rolePromptVersion: context.rolePromptVersion,
    framework: context.framework,
  });

  const summary = summarize(artifacts, screen);
  const policy = screen.decisions.find((decision) => decision.decisionPoint === 's2.policy');
  const report: HypothesisScreenReport = {
    requestId: context.requestId,
    runId: context.runId,
    role: 'searcher',
    decisionPoint: 's2.hypothesis-screen',
    mode: context.mode,
    hypothesesPath: context.hypothesesPath,
    hypothesesHash: context.hypothesesHash,
    ...(artifacts.rq ? { rq: artifacts.rq } : {}),
    summary,
    modelVersion: HYPOTHESIS_SCREEN_MODEL_VERSION,
    policyVersion: policy?.policyVersion ?? HYPOTHESIS_SCREEN_POLICY_VERSION,
    rendererVersion: HYPOTHESIS_SCREEN_RENDERER_VERSION,
    latencyMs: Date.now() - started,
  };
  return { report, markdown: renderHypothesisScreenReport(report, artifacts, screen), screen };
}

function summarize(artifacts: SearcherArtifacts, screen: SearcherScreenResult): HypothesisScreenSummary {
  const verdicts = { supported: 0, contradicted: 0, unknown: 0 };
  for (const verdict of screen.premiseVerdicts) verdicts[verdict.verdict] += 1;
  const premises = artifacts.hypotheses.reduce((total, card) => total + Math.max(1, card.premises?.length ?? 0), 0);
  const trigger = screen.decisions.find((decision) => decision.decisionPoint === 's3.trigger');
  const diversity = screen.decisions.find((decision) => decision.decisionPoint === 's5.diversity');
  // s3/s5 are optional and frequently off; only an S2 core fallback means the screen itself
  // could not do its job. Reporting the optional rule decisions as fallback would mislead.
  const fallback = screen.decisions.some(
    (decision) => decision.decisionPoint.startsWith('s2.') && decision.fallback,
  );
  const diversityFlags = diversity?.mode === 'off'
    ? []
    : (diversity?.flags ?? [])
      .filter((flag) => flag.code === 'top_k_redundant')
      .map((flag) => flag.code);
  return {
    cards: artifacts.hypotheses.length,
    premises,
    evidence: artifacts.evidence.length,
    verdicts,
    shortlist: [...screen.shortlist],
    ranked: [...screen.ranked],
    deferred: screen.deferred.map((entry) => ({ ...entry })),
    exploration: [...screen.exploration],
    deepReview: [...(trigger?.selected ?? [])],
    diversityFlags,
    fallback,
  };
}
