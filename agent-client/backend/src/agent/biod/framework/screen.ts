import { budgetFor } from './budget.js';
import type {
  Decision,
  DecisionPointId,
  DecisionRequest,
  Mode,
  Premise,
  PremiseVerdict,
  PremiseVerdictValue,
  SearcherArtifacts,
} from './contracts.js';
import { createSearcherFramework, type BiodFramework, type FrameworkOptions } from './orchestrator.js';

export interface SearcherScreenOptions {
  mode: Mode;
  /** Per-decision-point override; defaults to `mode`. */
  modes?: Partial<Record<DecisionPointId, Mode>>;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
  framework?: BiodFramework;
  frameworkOptions?: FrameworkOptions;
}

export interface SearcherScreenResult {
  decisions: Decision[];
  premiseVerdicts: PremiseVerdict[];
  shortlist: string[];
  ranked: string[];
  deferred: Array<{ id: string; reason: string }>;
  exploration: string[];
  fallback: boolean;
}

/**
 * End-to-end S2 pipeline for one Searcher run. This is the executable shadow surface:
 * it produces decisions and a shortlist but does not mutate the role behavior. Callers in
 * `shadow` ignore the shortlist; `assist` may use it.
 */
export async function screenSearcher(
  artifacts: SearcherArtifacts,
  options: SearcherScreenOptions,
): Promise<SearcherScreenResult> {
  const framework = options.framework ?? createSearcherFramework(options.frameworkOptions);
  const decisions: Decision[] = [];
  const premiseVerdicts: PremiseVerdict[] = [];
  let sequence = 0;

  for (const card of artifacts.hypotheses) {
    const premises: Premise[] = card.premises?.length
      ? card.premises
      : [{ pid: 'p0', text: card.claim, type: 'empirical' }];
    for (const premise of premises) {
      const links = card.evidenceLinks.length ? card.evidenceLinks : [{ eid: '', relation: 'neutral' as const }];
      const perPremise: PremiseVerdict[] = [];
      for (const link of links.slice(0, 2)) {
        const request = makeRequest(artifacts, options, 's2.premise', {
          requestId: `${options.runId}-s2.premise-${sequence++}`,
          focus: { hypId: card.id, pid: premise.pid, evidenceId: link.eid || undefined },
          budget: budgetFor('short'),
        });
        const decision = await framework.runDecision(request);
        decisions.push(decision);
        perPremise.push(toVerdict(decision, card.id, premise.pid, link.eid));
      }
      premiseVerdicts.push(aggregateVerdict(perPremise, card.id, premise.pid));
    }
  }

  const enriched: SearcherArtifacts = { ...artifacts, premiseVerdicts };
  const rerank = await framework.runDecision(makeRequest(enriched, options, 's2.rerank', { requestId: `${options.runId}-s2.rerank-${sequence++}`, budget: budgetFor('long') }));
  decisions.push(rerank);
  const rerankScores = rerank.ranked?.length
    ? Object.fromEntries(rerank.ranked.map((id, index) => [id, 1 - index / Math.max(1, rerank.ranked!.length)]))
    : {};
  const fused = await framework.runDecision(makeRequest({ ...enriched, rerankScores }, options, 's2.policy', { requestId: `${options.runId}-s2.policy-${sequence++}`, budget: budgetFor('rule') }));
  decisions.push(fused);
  const trigger = await framework.runDecision(makeRequest({ ...enriched, rerankScores }, options, 's3.trigger', { requestId: `${options.runId}-s3.trigger-${sequence++}`, budget: budgetFor('rule') }));
  decisions.push(trigger);
  const diversity = await framework.runDecision(makeRequest({ ...enriched, rerankScores }, options, 's5.diversity', { requestId: `${options.runId}-s5.diversity-${sequence++}`, budget: budgetFor('rule') }));
  decisions.push(diversity);

  return {
    decisions,
    premiseVerdicts,
    shortlist: fused.selected ?? [],
    ranked: fused.ranked ?? [],
    deferred: fused.deferred ?? [],
    exploration: fused.exploration ?? [],
    fallback: decisions.some((decision) => decision.fallback),
  };
}

function makeRequest(
  artifacts: SearcherArtifacts,
  options: SearcherScreenOptions,
  decisionPoint: DecisionRequest['decisionPoint'],
  extra: Partial<DecisionRequest>,
): DecisionRequest {
  return {
    requestId: `${options.runId}-${decisionPoint}-${Math.random().toString(36).slice(2, 8)}`,
    runId: options.runId,
    role: 'searcher',
    decisionPoint,
    mode: options.modes?.[decisionPoint] ?? options.mode,
    artifacts,
    budget: budgetFor('short'),
    context: { sessionId: options.sessionId, rolePromptVersion: options.rolePromptVersion, rendererVersion: 'searcher-screen-v1' },
    ...extra,
  };
}

function aggregateVerdict(verdicts: PremiseVerdict[], hypId: string, pid: string): PremiseVerdict {
  const contradicted = verdicts.find((verdict) => verdict.verdict === 'contradicted');
  if (contradicted) return { ...contradicted, hypId, pid };
  const supported = verdicts.find((verdict) => verdict.verdict === 'supported');
  if (supported) return { ...supported, hypId, pid };
  return verdicts[0] ?? { hypId, pid, verdict: 'unknown', confidence: 0, evidenceId: '' };
}

function toVerdict(decision: Decision, hypId: string, pid: string, evidenceId: string): PremiseVerdict {
  const value = decision.selected?.[0];
  const verdict: PremiseVerdictValue = value === 'supported' || value === 'contradicted' || value === 'unknown' ? value : 'unknown';
  return {
    hypId,
    pid,
    verdict,
    confidence: decision.confidence ?? 0,
    evidenceId,
    reasonCode: decision.fallback ? 'fallback' : 'scored',
  };
}
