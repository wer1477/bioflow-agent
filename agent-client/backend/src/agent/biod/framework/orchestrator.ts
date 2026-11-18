import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseSearcherArtifacts } from './artifacts.js';
import { budgetFor, fitBudget } from './budget.js';
import { SearcherCandidateBuilder } from './candidates.js';
import type {
  CandidateBuilder,
  Decision,
  DecisionLedger,
  DecisionPointId,
  DecisionRecord,
  DecisionRequest,
  FeatureProvider,
  FeatureSet,
  Policy,
  Renderer,
  Scorer,
  Signal,
} from './contracts.js';
import { EMPTY_FEATURES, failureDecision } from './contracts.js';
import { SearcherFeatureProvider } from './features.js';
import { S2FusionPolicy, S2PremisePolicy, S2RerankPolicy, S3TriggerPolicy, S5DiversityPolicy } from './policies.js';
import { RuleRenderer, S2PremiseRenderer, S2RerankRenderer } from './renderers.js';
import { SEARCHER_SPECS, searcherSpec } from './registry.js';

export interface FrameworkOptions {
  scorers?: Partial<Record<DecisionPointId, Scorer>>;
  candidateBuilder?: CandidateBuilder;
  featureProvider?: FeatureProvider;
  ledger?: DecisionLedger;
  specs?: Partial<Record<DecisionPointId, import('./contracts.js').DecisionPointSpec>>;
}

/**
 * Searcher-only orchestrator. Every path returns a Decision; failures are visible in
 * `fallback`/`flags` and in the ledger, never thrown at the role runtime.
 */
export class BiodFramework {
  private readonly scorers: Partial<Record<DecisionPointId, Scorer>>;
  private readonly candidateBuilder: CandidateBuilder;
  private readonly featureProvider: FeatureProvider;
  private readonly ledger: DecisionLedger;
  private readonly specs: typeof SEARCHER_SPECS;

  constructor(options: FrameworkOptions = {}) {
    this.scorers = options.scorers ?? {};
    this.candidateBuilder = options.candidateBuilder ?? new SearcherCandidateBuilder();
    this.featureProvider = options.featureProvider ?? new SearcherFeatureProvider();
    this.ledger = options.ledger ?? new JsonlDecisionLedger();
    this.specs = { ...SEARCHER_SPECS, ...(options.specs ?? {}) } as typeof SEARCHER_SPECS;
  }

  async runDecision(request: DecisionRequest): Promise<Decision> {
    const spec = this.specs[request.decisionPoint];
    if (!spec) return failureDecision(request, 'framework-v1', 'unknown_decision_point');
    if (request.mode === 'off' || !spec.modes.includes(request.mode)) {
      return this.finish(request, failureDecision(request, 'framework-v1', 'mode_off'), spec.budget, undefined, 'mode_off');
    }

    try {
      const parsed = parseSearcherArtifacts(request.artifacts);
      if (!parsed.ok) {
        return this.finish(request, failureDecision(request, 'framework-v1', 'invalid_artifacts'), spec.budget, undefined, 'invalid_artifacts');
      }
      request = { ...request, artifacts: parsed.artifacts };

      const candidates = request.candidates ?? await this.candidateBuilder.build(request);
      if (candidates.length < spec.minCandidates) {
        return this.finish(request, failureDecision(request, 'framework-v1', 'min_candidates'), spec.budget, undefined, 'min_candidates');
      }

      const renderer = this.renderer(spec.renderer);
      const budget = request.budget ?? budgetFor(spec.budget);
      const rendered = renderer.render(request, budget);
      const fit = fitBudget(rendered.state, candidates, budget);
      const boundedRequest: DecisionRequest = { ...request, candidates: fit.candidates, budget };

      const signal = await this.score(spec.scorer, boundedRequest, rendered.state, renderer.version);
      const features = await this.features(spec.features, boundedRequest, signal);
      const policy = this.policy(spec.policy);
      const decision = policy.decide(boundedRequest, signal, features);
      return this.finish(boundedRequest, decision, spec.budget, {
        rendererVersion: renderer.version,
        modelVersion: signal.modelVersion,
        state: rendered.state,
        estimatedTokens: fit.estimatedTokens,
        truncated: fit.truncated || rendered.truncated,
        candidates: candidates.map((candidate) => candidate.id),
        scores: signal.scores,
        latencyMs: signal.latencyMs,
      });
    } catch (error) {
      return this.finish(
        request,
        failureDecision(request, 'framework-v1', `exception:${error instanceof Error ? error.name : 'unknown'}`),
        spec.budget,
        undefined,
        'exception',
      );
    }
  }

  private async score(scorerName: string, request: DecisionRequest, state: string, rendererVersion: string): Promise<Signal> {
    if (scorerName === 'none') {
      return ruleSignal(rendererVersion);
    }
    const scorer = this.scorers[request.decisionPoint];
    if (!scorer) return ruleSignal('no_scorer');
    try {
      return await scorer.score({
        decisionPoint: request.decisionPoint,
        state,
        candidates: request.candidates ?? [],
        labels: request.decisionPoint === 's2.premise' ? request.candidates : undefined,
        budget: request.budget,
      });
    } catch {
      return { kind: 'rule', scores: {}, abstain: true, reasons: ['scorer_exception'], modelVersion: scorer.modelVersion, latencyMs: 0 };
    }
  }

  private async features(featureName: string, request: DecisionRequest, signal: Signal): Promise<FeatureSet> {
    if (featureName === 'none' || !this.featureProvider.supports(request.decisionPoint)) return EMPTY_FEATURES;
    try {
      return await this.featureProvider.compute(request, signal);
    } catch {
      return EMPTY_FEATURES;
    }
  }

  private renderer(name: string): Renderer {
    switch (name) {
      case 's2.premise.short': return new S2PremiseRenderer();
      case 's2.rerank.long': return new S2RerankRenderer();
      default: return new RuleRenderer();
    }
  }

  private policy(name: string): Policy {
    switch (name) {
      case 's2.premise': return new S2PremisePolicy();
      case 's2.rerank': return new S2RerankPolicy();
      case 's2.policy': return new S2FusionPolicy();
      case 's3.trigger': return new S3TriggerPolicy();
      case 's5.diversity': return new S5DiversityPolicy();
      default: return new S2FusionPolicy();
    }
  }

  private finish(
    request: DecisionRequest,
    decision: Decision,
    budgetProfile: import('./contracts.js').BudgetProfile,
    meta?: {
      rendererVersion: string;
      modelVersion: string;
      state: string;
      estimatedTokens: number;
      truncated: boolean;
      candidates: string[];
      scores: Record<string, number>;
      latencyMs: number;
    },
    fallbackReason?: string,
  ): Decision {
    const spec = searcherSpec(request.decisionPoint);
    const record: DecisionRecord = {
      ts: new Date().toISOString(),
      requestId: request.requestId,
      runId: request.runId,
      role: request.role,
      decisionPoint: request.decisionPoint,
      mode: request.mode,
      rendererVersion: meta?.rendererVersion ?? 'none',
      modelVersion: meta?.modelVersion ?? 'none',
      policyVersion: decision.policyVersion,
      stateHash: createHash('sha256').update(meta?.state ?? '').digest('hex').slice(0, 16),
      stateChars: meta?.state?.length ?? 0,
      estimatedTokens: meta?.estimatedTokens ?? 0,
      truncated: meta?.truncated ?? false,
      candidates: meta?.candidates ?? [],
      scores: meta?.scores ?? {},
      decision,
      fallback: decision.fallback,
      fallbackReason,
      latencyMs: meta?.latencyMs ?? 0,
    };
    try {
      this.ledger.append(record);
    } catch {
      // diagnostics only; never fail a decision because the log is unwritable
    }
    return { ...decision, signalRef: record.stateHash };
  }
}

export class JsonlDecisionLedger implements DecisionLedger {
  constructor(private readonly file: string = process.env.BIOFLOW_BIOD_DECISIONS_FILE ?? '') {}

  append(record: DecisionRecord): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // ignore
    }
  }
}

export function createSearcherFramework(options: FrameworkOptions = {}): BiodFramework {
  const heuristic = options.scorers?.['s2.premise'] ?? new HeuristicScorer();
  const rerank = options.scorers?.['s2.rerank'] ?? heuristic;
  return new BiodFramework({
    ...options,
    scorers: { 's2.premise': heuristic, 's2.rerank': rerank, ...(options.scorers ?? {}) },
  });
}

function ruleSignal(reason: string): Signal {
  return { kind: 'rule', scores: {}, abstain: false, reasons: [reason], modelVersion: 'rule-v1', latencyMs: 0 };
}

// Imported here to keep createSearcherFramework's default explicit without a second module.
import { HeuristicScorer } from './scorers.js';
