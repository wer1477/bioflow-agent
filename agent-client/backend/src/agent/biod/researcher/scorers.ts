import type {
  BiodCandidate,
  BiodResult,
  BiodToolDecision,
} from '../types.js';
import type { StateBudget } from '../framework/contracts.js';
import {
  RoleHeadClient,
  clamp01,
  ROLE_HEAD_MODEL_VERSION,
  type HeadScorerOptions,
} from '../head_client.js';
import { NO_TOOL_ID, type PlanAuditScorer, type PlanAuditSignal, type PlanStep, type PlanToolCandidate } from './contracts.js';

/**
 * Scorers for R1. None of these edit the plan or load a tool. A future trained head only
 * implements `PlanAuditScorer`; the pipeline, candidates, policy and report stay unchanged.
 */

export interface ToolDecisionService {
  decideTool(input: { state: string; candidates: BiodCandidate[]; role?: string }): Promise<BiodResult<BiodToolDecision>>;
}

export class MockPlanAuditScorer implements PlanAuditScorer {
  readonly modelVersion = 'mock-r1-v1';
  readonly variant = 'full' as const;

  constructor(private readonly table: Record<string, Record<string, number>> = {}) {}

  async score(input: {
    step: PlanStep;
    state: string;
    candidates: PlanToolCandidate[];
    budget: StateBudget;
  }): Promise<PlanAuditSignal> {
    const configured = this.table[input.step.id] ?? {};
    const scores: Record<string, number> = {};
    for (const candidate of input.candidates) {
      scores[candidate.id] = configured[candidate.id] ?? deterministicScore(input.step.id, candidate.id);
    }
    return {
      scores,
      confidence: Object.keys(configured).length ? 0.9 : 0.5,
      abstain: false,
      reasons: ['mock'],
      latencyMs: 0,
    };
  }
}

/** Deterministic lexical baseline; useful for shadow and as a fallback when v0 is off. */
export class HeuristicPlanAuditScorer implements PlanAuditScorer {
  readonly modelVersion = 'heuristic-r1-v1';
  readonly variant = 'full' as const;

  async score(input: {
    step: PlanStep;
    state: string;
    candidates: PlanToolCandidate[];
    budget: StateBudget;
  }): Promise<PlanAuditSignal> {
    const started = Date.now();
    const stepTokens = tokensFor([
      input.step.goal,
      ...input.step.inputs,
      ...input.step.outputs,
      ...input.step.constraints,
      input.step.currentApproach ?? '',
      input.step.currentToolId ?? '',
    ].join(' '));
    const scores: Record<string, number> = {};
    let best = 0;
    for (const candidate of input.candidates) {
      if (candidate.id === NO_TOOL_ID) continue;
      const coverage = coverageOf(stepTokens, `${candidate.name} ${candidate.description}`);
      const score = round(0.2 + 0.7 * coverage);
      scores[candidate.id] = score;
      best = Math.max(best, score);
    }
    scores[NO_TOOL_ID] = round(Math.max(0.05, 0.45 - best * 0.3));
    return {
      scores,
      confidence: round(Math.min(1, 0.35 + best * 0.6)),
      abstain: false,
      reasons: ['heuristic'],
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Reuses the deployed v0 tool head. It is a shadow adapter, not the default: its training
 * distribution is a user request, not a plan step, and it masks candidates outside the
 * frozen checkpoint vocabulary.
 */
export class BiodToolScorer implements PlanAuditScorer {
  readonly modelVersion = 'biod-v0-tool-adapter';
  readonly variant = 'short' as const;

  constructor(private readonly service: ToolDecisionService) {}

  async score(input: {
    step: PlanStep;
    state: string;
    candidates: PlanToolCandidate[];
    budget: StateBudget;
  }): Promise<PlanAuditSignal> {
    const started = Date.now();
    const candidates: BiodCandidate[] = input.candidates
      .filter((candidate) => candidate.id !== NO_TOOL_ID)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
        kind: candidate.kind === 'mcp' ? 'mcp' : 'skill',
      }));
    if (!candidates.length) {
      return abstain('no_candidates', this.modelVersion, started);
    }
    const result = await this.service.decideTool({ state: input.state, candidates, role: 'researcher' });
    if (!result.ok) return abstain(result.reason, this.modelVersion, started);
    const scores: Record<string, number> = {};
    for (const candidate of input.candidates) {
      if (candidate.id === NO_TOOL_ID) continue;
      scores[candidate.id] = result.scores.find((score) => score.id === candidate.id)?.p ?? 0;
    }
    scores[NO_TOOL_ID] = result.noToolProb;
    const scoredIds = new Set(result.scores.map((score) => score.id));
    const masked = candidates.map((candidate) => candidate.id).filter((id) => !scoredIds.has(id));
    return {
      scores,
      confidence: result.confidence,
      abstain: false,
      reasons: masked.length ? ['biod-tool', `masked:${masked.length}`] : ['biod-tool'],
      latencyMs: result.latencyMs ?? Date.now() - started,
      ...(masked.length ? { masked } : {}),
    };
  }
}

/**
 * R1 adapter for the trained tool pointer (`biod-mt-v2`, reuses the `tool_select` head).
 *
 * The state is rebuilt from the `PlanStep` (goal + inputs + outputs + constraints) instead
 * of the renderer's candidate table: the head scores the step and the candidate ids, and
 * the endpoint rejects a candidate list contaminated with the `NO_TOOL` pseudo-row. The
 * response's `noToolProb` becomes the `NO_TOOL` score the policy expects.
 *
 * Fail-open: any failure (or a candidate set with no real tools) abstains.
 */
export class HttpPlanAuditScorer implements PlanAuditScorer {
  readonly modelVersion = ROLE_HEAD_MODEL_VERSION;
  readonly variant = 'full' as const;
  private readonly client: RoleHeadClient;

  constructor(options: HeadScorerOptions) {
    this.client = new RoleHeadClient(options);
  }

  async score(input: {
    step: PlanStep;
    state: string;
    candidates: PlanToolCandidate[];
    budget: StateBudget;
  }): Promise<PlanAuditSignal> {
    const started = Date.now();
    const candidates = input.candidates.filter((candidate) => candidate.id !== NO_TOOL_ID);
    if (!candidates.length) return abstain('no_candidates', this.modelVersion, started);
    const state = planStepState(input.step);
    if (!state.trim()) return abstain('empty_state', this.modelVersion, started);

    const response = await this.client.decideTool(state, candidates.map((candidate) => candidate.id));
    if (!response.ok) return abstain(response.reason, this.modelVersion, started);
    if (!response.value.scores.length) return abstain('bad_response', this.modelVersion, started);

    const scores: Record<string, number> = {};
    for (const candidate of candidates) {
      const score = response.value.scores.find((entry) => entry.id === candidate.id);
      scores[candidate.id] = clamp01(score?.p ?? 0);
    }
    scores[NO_TOOL_ID] = clamp01(response.value.noToolProb);
    return {
      scores,
      confidence: clamp01(response.value.confidence),
      abstain: false,
      reasons: ['biod-mt-v2', 'tool-select'],
      latencyMs: response.value.latencyMs ?? response.latencyMs,
    };
  }
}

/** The single-string step state the tool head was trained on. */
function planStepState(step: PlanStep): string {
  const lines = [`Step: ${step.goal}`];
  if (step.inputs.length) lines.push(`Inputs: ${step.inputs.join('; ')}`);
  if (step.outputs.length) lines.push(`Outputs: ${step.outputs.join('; ')}`);
  if (step.constraints.length) lines.push(`Constraints: ${step.constraints.join('; ')}`);
  return lines.join('\n');
}

export function createPlanAuditScorer(
  name: string,
  service?: ToolDecisionService,
  options?: HeadScorerOptions,
): PlanAuditScorer {
  switch (name) {
    case 'mock': return new MockPlanAuditScorer();
    case 'biod-tool': return service ? new BiodToolScorer(service) : new HeuristicPlanAuditScorer();
    case 'http': {
      if (!options?.baseUrl?.trim()) {
        throw new Error('createPlanAuditScorer("http") requires a base URL (biod.service.baseUrl)');
      }
      return new HttpPlanAuditScorer(options);
    }
    case 'heuristic':
    default: return new HeuristicPlanAuditScorer();
  }
}

function abstain(reason: string, modelVersion: string, started: number): PlanAuditSignal {
  return {
    scores: {},
    confidence: 0,
    abstain: true,
    reasons: [reason],
    latencyMs: Date.now() - started,
  };
}

function tokensFor(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9_./+-]+|[\u4e00-\u9fff]/g) ?? [];
  return new Set(matches.filter((token) => token.length > 0));
}

function coverageOf(stepTokens: Set<string>, toolText: string): number {
  if (stepTokens.size === 0) return 0;
  const toolTokens = tokensFor(toolText);
  if (toolTokens.size === 0) return 0;
  let matches = 0;
  for (const token of stepTokens) if (toolTokens.has(token)) matches += 1;
  return matches / stepTokens.size;
}

function deterministicScore(stepId: string, toolId: string): number {
  let hash = 2166136261;
  for (const char of `${stepId}:${toolId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return round((hash >>> 0) % 1000 / 1000);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
