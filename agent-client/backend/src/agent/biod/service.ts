import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_STATE_ROOT } from '../../paths.js';
import { isBiodDisabledByEnv, loadBiodConfig, matchesBiodModelVersion, type BiodConfig, type BiodFrameworkConfig } from './config.js';
import {
  HttpBiodClient,
  isBiodHealthReady,
  type BiodClient,
  type BiodHealth,
} from './client.js';
import { BiodProcessSupervisor, type BiodEnsureRunningResult } from './supervisor.js';
import { BiodFramework, createSearcherFramework, HeuristicScorer, HttpScorer, JsonlDecisionLedger, screenSearcher } from './framework/index.js';
import type { Decision, DecisionPointId, DecisionRequest, Mode, Scorer, SearcherArtifacts, SearcherScreenResult } from './framework/index.js';
import { budgetFor } from './framework/budget.js';
import { screenHypotheses } from './searcher/screen.js';
import { JsonlHypothesisScreenLedger, toHypothesisScreenRecord } from './searcher/ledger.js';
import type { HypothesisScreenResult, HypothesisScreenServiceInput } from './searcher/contracts.js';
import { auditPlan } from './researcher/audit.js';
import { auditIssues } from './reviewer/audit.js';
import { JsonlIssueAuditLedger, toIssueAuditRecord } from './reviewer/ledger.js';
import { ISSUE_AUDIT_DEFAULT_BUDGET, ISSUE_AUDIT_DEFAULT_SCORER, ISSUE_TRIAGE_DECISION_POINT } from './reviewer/registry.js';
import { createIssueTriageScorer } from './reviewer/scorers.js';
import { auditManuscript } from './writer/audit.js';
import { JsonlManuscriptAuditLedger, toManuscriptAuditRecord } from './writer/ledger.js';
import { MANUSCRIPT_AUDIT_DECISION_POINT, MANUSCRIPT_AUDIT_DEFAULT_BUDGET, MANUSCRIPT_AUDIT_DEFAULT_SCORER } from './writer/registry.js';
import { createManuscriptAuditScorer } from './writer/scorers.js';
import { JsonlPlanAuditLedger, toPlanAuditRecord } from './researcher/ledger.js';
import { PLAN_AUDIT_DECISION_POINT, PLAN_AUDIT_DEFAULT_BUDGET, PLAN_AUDIT_DEFAULT_SCORER } from './researcher/registry.js';
import { renderPlanAuditReport } from './researcher/report.js';
import { createPlanAuditScorer } from './researcher/scorers.js';
import type {
  PlanAuditRequest,
  PlanAuditResult,
  PlanAuditScorer,
  PlanAuditServiceInput,
} from './researcher/contracts.js';
import type {
  IssueAuditRequest,
  IssueAuditResult,
  IssueTriageScorer,
  IssueAuditServiceInput,
} from './reviewer/contracts.js';
import type {
  ManuscriptAuditRequest,
  ManuscriptAuditResult,
  ManuscriptAuditScorer,
  ManuscriptAuditServiceInput,
} from './writer/contracts.js';
import type {
  BiodCandidate,
  BiodDecisionPoint,
  BiodFailure,
  BiodFailureReason,
  BiodGroupScores,
  BiodKbDecision,
  BiodResult,
  BiodToolDecision,
} from './types.js';

/**
 * The one entry point consumers use for biod decisions.
 *
 * Design rules:
 * - Every public method satisfies `never throws`; failures are `BiodFailure` values whose
 *   `reason` is a closed set (see types.ts). A model hiccup must cost metadata, not a run.
 * - Policy lives at the call site. This service returns the raw decision and never turns
 *   `low confidence` or `NO_TOOL` into a failure, because the fallback (browse the catalog,
 *   read the index) is the caller's business and the caller has the config.
 * - No implicit restart on a decision call. Readiness is decided once in `start()`; a call
 *   during a dead sidecar fails fast to `not_ready`/`timeout` instead of stalling the turn.
 */

export interface BiodServiceStatus {
  enabled: boolean;
  ready: boolean;
  reason?: BiodFailureReason;
  modelVersion?: string;
}

export interface BiodSupervisorLike {
  ensureRunning(): Promise<BiodEnsureRunningResult>;
  stop(): Promise<void>;
}

export interface BiodServiceOptions {
  /** Defaults to `loadBiodConfig()`; tests inject a config instead of touching disk. */
  config?: BiodConfig;
  client?: BiodClient;
  supervisor?: BiodSupervisorLike;
  /** Decision audit log; defaults to `RUNTIME_STATE_ROOT/biod-decisions.jsonl`. */
  decisionsFile?: string;
  /** Environment used for the `BIOFLOW_BIOD_DISABLED` kill switch. */
  environment?: NodeJS.ProcessEnv;
  /** Optional prebuilt Searcher decision framework (tests inject a mock scorer). */
  framework?: BiodFramework;
  /** S2 hypothesis-screen ledger; defaults to `RUNTIME_STATE_ROOT/biod-hypothesis-screen.jsonl`. */
  hypothesisScreenLedgerFile?: string;
  /** R1 plan-audit ledger; defaults to `RUNTIME_STATE_ROOT/biod-plan-audit.jsonl`. */
  planAuditLedgerFile?: string;
  /** Test/gray-release scorer override; config still decides whether the audit runs. */
  planAuditScorer?: PlanAuditScorer;
  /** W1 writer audit ledger; defaults to `RUNTIME_STATE_ROOT/biod-manuscript-audit.jsonl`. */
  manuscriptAuditLedgerFile?: string;
  /** Test/gray-release W1 scorer override; config still decides whether the audit runs. */
  manuscriptAuditScorer?: ManuscriptAuditScorer;
  /** V1 reviewer issue-audit ledger; defaults to `RUNTIME_STATE_ROOT/biod-issue-audit.jsonl`. */
  issueAuditLedgerFile?: string;
  /** Test/gray-release V1 scorer override; config still decides whether the audit runs. */
  issueTriageScorer?: IssueTriageScorer;
}

export interface BiodDecisionInput {
  state: string;
  candidates: BiodCandidate[];
  /** Optional role prefix, so the multitask model sees the same layout as training. */
  role?: string;
}

function withRole(input: BiodDecisionInput): string {
  return input.role ? `[角色：${input.role}]\n${input.state}` : input.state;
}

export interface BiodScoreGroupsInput {
  state: string;
  groups: Array<{ id: string; name: string; description: string }>;
}

type DecisionKind = 'tool' | 'kb' | 'groups';

type DecisionGuard = { ok: true; state: string } | { ok: false; failure: BiodFailure };

export class BiodService {
  private readonly providedConfig?: BiodConfig;
  private readonly providedClient?: BiodClient;
  private readonly providedSupervisor?: BiodSupervisorLike;
  private readonly decisionsFile: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly providedFramework?: BiodFramework;
  private readonly hypothesisScreenLedgerFile: string;
  private readonly providedPlanAuditScorer?: PlanAuditScorer;
  private readonly planAuditLedgerFile: string;
  private readonly providedManuscriptAuditScorer?: ManuscriptAuditScorer;
  private readonly manuscriptAuditLedgerFile: string;
  private readonly providedIssueTriageScorer?: IssueTriageScorer;
  private readonly issueAuditLedgerFile: string;
  private planAuditLedgerCache: JsonlPlanAuditLedger | null = null;
  private manuscriptAuditLedgerCache: JsonlManuscriptAuditLedger | null = null;
  private issueAuditLedgerCache: JsonlIssueAuditLedger | null = null;
  private hypothesisScreenLedgerCache: JsonlHypothesisScreenLedger | null = null;
  private frameworkCache: BiodFramework | null = null;
  private configCache: BiodConfig | null;
  private clientCache: BiodClient | null = null;
  private supervisorCache: BiodSupervisorLike | null = null;
  private status: BiodServiceStatus = { enabled: false, ready: false, reason: 'disabled' };
  private startPromise: Promise<void> | null = null;
  /** Checkpoint vocabulary; absent means "do not mask" (older sidecar / test double). */
  private vocab: { tool: Set<string>; kb: Set<string> } | null = null;

  constructor(options: BiodServiceOptions = {}) {
    this.providedConfig = options.config;
    this.providedClient = options.client;
    this.providedSupervisor = options.supervisor;
    this.configCache = options.config ?? null;
    this.decisionsFile = options.decisionsFile ?? path.join(RUNTIME_STATE_ROOT, 'biod-decisions.jsonl');
    this.environment = options.environment ?? process.env;
    this.providedFramework = options.framework;
    this.hypothesisScreenLedgerFile = options.hypothesisScreenLedgerFile
      ?? path.join(RUNTIME_STATE_ROOT, 'biod-hypothesis-screen.jsonl');
    this.providedPlanAuditScorer = options.planAuditScorer;
    this.planAuditLedgerFile = options.planAuditLedgerFile
      ?? path.join(RUNTIME_STATE_ROOT, 'biod-plan-audit.jsonl');
    this.providedManuscriptAuditScorer = options.manuscriptAuditScorer;
    this.manuscriptAuditLedgerFile = options.manuscriptAuditLedgerFile
      ?? path.join(RUNTIME_STATE_ROOT, 'biod-manuscript-audit.jsonl');
    this.providedIssueTriageScorer = options.issueTriageScorer;
    this.issueAuditLedgerFile = options.issueAuditLedgerFile
      ?? path.join(RUNTIME_STATE_ROOT, 'biod-issue-audit.jsonl');
  }

  /** Idempotent; concurrent callers share one start. Never throws. */
  async start(): Promise<void> {
    if (this.status.ready) return;
    if (this.startPromise) return this.startPromise;
    const run = this.startInternal()
      .catch((error: unknown) => {
        this.setStatus({ enabled: true, ready: false, reason: 'not_ready' });
        this.warn(`start failed: ${describeError(error)}`);
      })
      .finally(() => {
        this.startPromise = null;
      });
    this.startPromise = run;
    return run;
  }

  /** Stops only a sidecar this process spawned; adopted services are left running. */
  async stop(): Promise<void> {
    if (this.supervisorCache) {
      try {
        await this.supervisorCache.stop();
      } catch (error) {
        this.warn(`stop failed: ${describeError(error)}`);
      }
    }
    this.setStatus({ enabled: this.isEnabled(this.config()), ready: false, reason: 'not_ready' });
  }

  getStatus(): BiodServiceStatus {
    return { ...this.status };
  }

  /**
   * Searcher decision framework entry point. This is model-free by default (heuristic
   * scorer): it can shadow S2 without a sidecar and never blocks the role runtime.
   */
  async runDecision(request: DecisionRequest): Promise<Decision> {
    return this.framework().runDecision(request);
  }

  /**
   * Config-driven Searcher screen. Returns an empty/fallback result unless
   * `biod.json.framework.enabled` is true, so an unconfigured backend pays nothing.
   */
  async runSearcherScreen(
    artifacts: SearcherArtifacts,
    options: { runId: string; sessionId: string; rolePromptVersion: string },
  ): Promise<SearcherScreenResult> {
    const framework = this.config().framework;
    if (!framework?.enabled) return emptyScreenResult();
    const modes: Partial<Record<DecisionPointId, Mode>> = {};
    for (const [decisionPoint, point] of Object.entries(framework.decisionPoints)) {
      if (point?.mode) modes[decisionPoint as DecisionPointId] = point.mode;
    }
    return screenSearcher(artifacts, {
      ...options,
      mode: framework.defaultMode,
      modes,
      framework: this.framework(),
    });
  }

  /**
   * Searcher S2: screen the Searcher's structured hypotheses and return a report. It ranks
   * cards for deep review and explains premise verdicts; it never generates or edits a
   * hypothesis, never loads a tool, and never gates the role. Config decides whether the
   * screen runs at all.
   */
  async runHypothesisScreen(input: HypothesisScreenServiceInput): Promise<HypothesisScreenResult> {
    try {
      const framework = this.config().framework;
      if (!framework?.enabled) {
        return { ok: false, reason: 'disabled', message: 'biod framework is disabled' };
      }
      const mode = effectiveSearcherMode(framework);
      if (mode === 'off') {
        return { ok: false, reason: 'disabled', message: 'S2 decision points are off' };
      }
      if (!input.artifacts.hypotheses.length) {
        return { ok: false, reason: 'no_cards', message: 'hypotheses.yaml has no hypothesis cards' };
      }
      const modes: Partial<Record<DecisionPointId, Mode>> = {
        's2.premise': mode,
        's2.rerank': mode,
        's2.policy': mode,
        's3.trigger': supportingSearcherMode(framework, 's3.trigger', ['off', 'shadow', 'trigger']),
        's5.diversity': supportingSearcherMode(framework, 's5.diversity', ['off', 'shadow', 'guard']),
      };
      const { report, markdown, screen } = await screenHypotheses(input.artifacts, {
        requestId: input.requestId,
        runId: input.runId,
        sessionId: input.sessionId,
        rolePromptVersion: input.rolePromptVersion,
        hypothesesPath: input.hypothesesPath,
        hypothesesHash: input.hypothesesHash,
        mode,
        modes,
        framework: this.framework(),
      });
      this.hypothesisScreenLedger().append(toHypothesisScreenRecord(report));
      return { ok: true, report, markdown, screen };
    } catch (error) {
      return { ok: false, reason: 'bad_response', message: describeError(error) };
    }
  }

  /**
   * Researcher R1: audit an already-written plan's executable steps against the role's
   * bound tools. It only returns a report; it never edits the plan, loads a tool, or gates
   * execution. Config decides whether the audit runs at all.
   */
  async runPlanAudit(input: PlanAuditServiceInput): Promise<PlanAuditResult> {
    try {
      const framework = this.config().framework;
      const researcher = framework?.researcher;
      if (!framework?.enabled || !researcher?.enabled) {
        return { ok: false, reason: 'disabled', message: 'researcher framework is disabled' };
      }
      const point = researcher.decisionPoints[PLAN_AUDIT_DECISION_POINT];
      const mode = point?.mode === 'assist' ? 'assist' : point?.mode === 'shadow' ? 'shadow' : 'off';
      if (!point || mode === 'off') {
        return { ok: false, reason: 'disabled', message: 'r1.plan-audit is off' };
      }
      if (!input.steps.length) return { ok: false, reason: 'no_steps', message: 'plan has no executable steps' };
      if (!input.tools.length) return { ok: false, reason: 'no_candidates', message: 'researcher has no visible tools' };

      const budget = budgetFor(point.budget ?? PLAN_AUDIT_DEFAULT_BUDGET);
      if (budget.profile === 'rule' || budget.maxTotalTokens <= 0) {
        return { ok: false, reason: 'disabled', message: 'r1.plan-audit budget is rule' };
      }
      const service = this.config().service;
      const scorer = this.providedPlanAuditScorer
        ?? createPlanAuditScorer(point.scorer ?? PLAN_AUDIT_DEFAULT_SCORER, this, {
          baseUrl: service.baseUrl,
          timeoutMs: service.requestTimeoutMs,
        });
      const request: PlanAuditRequest = {
        requestId: input.requestId,
        runId: input.runId,
        role: 'researcher',
        planPath: input.planPath,
        planHash: input.planHash,
        steps: input.steps,
        tools: input.tools,
        mode,
        budget,
        thresholds: researcher.thresholds,
        prefilter: researcher.prefilter,
        context: {
          sessionId: input.sessionId,
          rolePromptVersion: input.rolePromptVersion,
          rendererVersion: scorer.variant === 'short' ? 'r1.plan-audit.short-v1' : 'r1.plan-audit.full-v1',
        },
      };
      const { report, trace } = await auditPlan(request, { scorer, thresholds: researcher.thresholds });
      const markdown = renderPlanAuditReport(report);
      this.planAuditLedger().append(toPlanAuditRecord(report, trace));
      return { ok: true, report, markdown, trace };
    } catch (error) {
      return { ok: false, reason: 'bad_response', message: describeError(error) };
    }
  }

  /**
   * Writer W1: audit a first draft's claim-evidence map. It only returns a report; it never
   * edits the manuscript or the CSV, loads a tool, or gates submission.
   */
  async runManuscriptAudit(input: ManuscriptAuditServiceInput): Promise<ManuscriptAuditResult> {
    try {
      const framework = this.config().framework;
      const writer = framework?.writer;
      if (!framework?.enabled || !writer?.enabled) {
        return { ok: false, reason: 'disabled', message: 'writer framework is disabled' };
      }
      const point = writer.decisionPoints[MANUSCRIPT_AUDIT_DECISION_POINT];
      const mode = point?.mode === 'assist' ? 'assist' : point?.mode === 'shadow' ? 'shadow' : 'off';
      if (!point || mode === 'off') {
        return { ok: false, reason: 'disabled', message: 'w1.claim-evidence-audit is off' };
      }
      const budget = budgetFor(point.budget ?? MANUSCRIPT_AUDIT_DEFAULT_BUDGET);
      if (budget.profile === 'rule' || budget.maxTotalTokens <= 0) {
        return { ok: false, reason: 'disabled', message: 'w1.claim-evidence-audit budget is rule' };
      }
      const service = this.config().service;
      const scorer = this.providedManuscriptAuditScorer
        ?? createManuscriptAuditScorer(point.scorer ?? MANUSCRIPT_AUDIT_DEFAULT_SCORER, {
          baseUrl: service.baseUrl,
          timeoutMs: service.pairTimeoutMs,
        });
      const request: ManuscriptAuditRequest = {
        requestId: input.requestId,
        runId: input.runId,
        role: 'writer',
        manuscriptPath: input.manuscriptPath,
        matrixPath: input.matrixPath,
        ...(input.referencesPath ? { referencesPath: input.referencesPath } : {}),
        manuscriptContent: input.manuscriptContent,
        matrixContent: input.matrixContent,
        ...(input.referencesContent !== undefined ? { referencesContent: input.referencesContent } : {}),
        figures: input.figures,
        tables: input.tables,
        mode,
        budget,
        thresholds: writer.thresholds,
        precheck: writer.precheck,
        context: {
          sessionId: input.sessionId,
          rolePromptVersion: input.rolePromptVersion,
          rendererVersion: scorer.variant === 'short' ? 'w1.claim-evidence-audit.short-v1' : 'w1.claim-evidence-audit.full-v1',
        },
      };
      const result = await auditManuscript(request, { scorer });
      if (result.ok) this.manuscriptAuditLedger().append(toManuscriptAuditRecord(result.report));
      return result;
    } catch (error) {
      return { ok: false, reason: 'bad_response', message: describeError(error) };
    }
  }

  /**
   * Reviewer V1: check the premises, ownership and relative order of issues that already
   * exist. It only returns a report; it never creates issues, edits the review, assigns a
   * severity grade, dispatches work, or gates a decision.
   */
  async runIssueAudit(input: IssueAuditServiceInput): Promise<IssueAuditResult> {
    try {
      const framework = this.config().framework;
      const reviewer = framework?.reviewer;
      if (!framework?.enabled || !reviewer?.enabled) {
        return { ok: false, reason: 'disabled', message: 'reviewer framework is disabled' };
      }
      const point = reviewer.decisionPoints[ISSUE_TRIAGE_DECISION_POINT];
      const mode = point?.mode === 'assist' ? 'assist' : point?.mode === 'shadow' ? 'shadow' : 'off';
      if (!point || mode === 'off') {
        return { ok: false, reason: 'disabled', message: 'v1.issue-triage is off' };
      }
      const budgetProfile = point.budget ?? ISSUE_AUDIT_DEFAULT_BUDGET;
      const budget = budgetFor(budgetProfile);
      if (budget.profile === 'rule' || budget.maxTotalTokens <= 0) {
        return { ok: false, reason: 'disabled', message: 'v1.issue-triage budget is rule' };
      }
      const service = this.config().service;
      const scorer = this.providedIssueTriageScorer
        ?? createIssueTriageScorer(point.scorer ?? ISSUE_AUDIT_DEFAULT_SCORER, {
          pairMargin: reviewer.thresholds.pairMargin,
          baseUrl: service.baseUrl,
          timeoutMs: service.pairTimeoutMs,
        });
      const request: IssueAuditRequest = {
        requestId: input.requestId,
        runId: input.runId,
        role: 'reviewer',
        documentPath: input.documentPath,
        issuesPath: input.issuesPath,
        documentContent: input.documentContent,
        issuesContent: input.issuesContent,
        mode,
        budget,
        thresholds: reviewer.thresholds,
        context: {
          sessionId: input.sessionId,
          rolePromptVersion: input.rolePromptVersion,
          rendererVersion: scorer.variant === 'short' ? 'v1.issue-triage.short-v1' : 'v1.issue-triage.full-v1',
        },
      };
      const result = await auditIssues(request, { scorer });
      if (result.ok) {
        this.issueAuditLedger().append(toIssueAuditRecord(result.report, {
          budgetProfile,
          thresholds: reviewer.thresholds,
        }));
      }
      return result;
    } catch (error) {
      return { ok: false, reason: 'bad_response', message: describeError(error) };
    }
  }

  private issueAuditLedger(): JsonlIssueAuditLedger {
    if (!this.issueAuditLedgerCache) {
      this.issueAuditLedgerCache = new JsonlIssueAuditLedger(this.issueAuditLedgerFile);
    }
    return this.issueAuditLedgerCache;
  }

  private manuscriptAuditLedger(): JsonlManuscriptAuditLedger {
    if (!this.manuscriptAuditLedgerCache) {
      this.manuscriptAuditLedgerCache = new JsonlManuscriptAuditLedger(this.manuscriptAuditLedgerFile);
    }
    return this.manuscriptAuditLedgerCache;
  }

  private planAuditLedger(): JsonlPlanAuditLedger {
    if (!this.planAuditLedgerCache) {
      this.planAuditLedgerCache = new JsonlPlanAuditLedger(this.planAuditLedgerFile);
    }
    return this.planAuditLedgerCache;
  }

  private hypothesisScreenLedger(): JsonlHypothesisScreenLedger {
    if (!this.hypothesisScreenLedgerCache) {
      this.hypothesisScreenLedgerCache = new JsonlHypothesisScreenLedger(this.hypothesisScreenLedgerFile);
    }
    return this.hypothesisScreenLedgerCache;
  }

  private framework(): BiodFramework {
    if (!this.frameworkCache) {
      this.frameworkCache = this.providedFramework ?? createSearcherFramework({
        ledger: new JsonlDecisionLedger(path.join(path.dirname(this.decisionsFile), 'biod-framework-decisions.jsonl')),
        scorers: this.searcherScorers(),
      });
    }
    return this.frameworkCache;
  }

  /**
   * Scorer selection for the Searcher S2 decision points.
   *
   * `s2.premise` honours `framework.decisionPoints["s2.premise"].scorer`:
   *   - `heuristic` (default): no sidecar needed, deterministic keyword rules.
   *   - `http`: trained H6 head at `service.baseUrl` (`biod-mt-v2`).
   * Anything else keeps the heuristic scorer and records a config warning instead of
   * silently pretending the trained head is wired.
   *
   * `s2.rerank` has no trained head; it always stays heuristic.
   */
  private searcherScorers(): Partial<Record<DecisionPointId, Scorer>> {
    return {
      's2.premise': this.searcherPremiseScorer(),
      's2.rerank': new HeuristicScorer(),
    };
  }

  private searcherPremiseScorer(): Scorer {
    const config = this.config();
    const configured = config.framework?.decisionPoints['s2.premise']?.scorer?.trim().toLowerCase();
    if (!configured || configured === 'heuristic') return new HeuristicScorer();
    if (configured === 'http') {
      const baseUrl = String(config.service.baseUrl ?? '').trim();
      if (baseUrl) {
        return new HttpScorer({ baseUrl, timeoutMs: config.service.pairTimeoutMs });
      }
      const warning = 'biod.framework.decisionPoints.s2.premise.scorer: "http" requires service.baseUrl; using heuristic.';
      config.warnings.push(warning);
      this.warn(warning);
      return new HeuristicScorer();
    }
    const warning = `biod.framework.decisionPoints.s2.premise.scorer: "${configured}" is not supported; using heuristic.`;
    config.warnings.push(warning);
    this.warn(warning);
    return new HeuristicScorer();
  }

  async decideTool(input: BiodDecisionInput): Promise<BiodResult<BiodToolDecision>> {
    const guard = this.guardDecision('tool_select', withRole(input));
    if (!guard.ok) {
      this.recordFailure('tool', input.state, guard.failure);
      return guard.failure;
    }
    const config = this.config();
    const policy = config.decisionPoints.tool_select;
    const candidates = this.maskCandidates('tool', input.candidates);
    if (!candidates.length) {
      const failure: BiodFailure = { ok: false, reason: 'catalog_mismatch', message: 'no candidate is in the checkpoint vocabulary' };
      this.recordFailure('tool', guard.state, failure);
      return failure;
    }
    const result = await this.callClient('tool', guard.state, () =>
      this.client().decideTool(guard.state, candidates, { tau: policy.tau }),
    );
    this.recordDecision('tool', guard.state, result);
    return result;
  }

  async decideKnowledge(input: BiodDecisionInput): Promise<BiodResult<BiodKbDecision>> {
    const guard = this.guardDecision('kb_select', withRole(input));
    if (!guard.ok) {
      this.recordFailure('kb', input.state, guard.failure);
      return guard.failure;
    }
    const config = this.config();
    const policy = config.decisionPoints.kb_select;
    const candidates = this.maskCandidates('kb', input.candidates);
    if (!candidates.length) {
      const failure: BiodFailure = { ok: false, reason: 'catalog_mismatch', message: 'no candidate is in the checkpoint vocabulary' };
      this.recordFailure('kb', guard.state, failure);
      return failure;
    }
    const result = await this.callClient('kb', guard.state, () =>
      this.client().decideKb(guard.state, candidates, { tau: policy.tau, topK: policy.topK }),
    );
    this.recordDecision('kb', guard.state, result);
    return result;
  }

  async scoreGroups(input: BiodScoreGroupsInput): Promise<BiodResult<BiodGroupScores>> {
    const guard = this.guardDecision('context_retention', input.state);
    if (!guard.ok) {
      this.recordFailure('groups', input.state, guard.failure);
      return guard.failure;
    }
    const groups = Array.isArray(input.groups)
      ? input.groups.slice(0, this.config().decisionPoints.context_retention.maxGroups)
      : [];
    const result = await this.callClient('groups', guard.state, () => this.client().scoreGroups(guard.state, groups));
    this.recordDecision('groups', guard.state, result);
    return result;
  }

  private async startInternal(): Promise<void> {
    const config = this.config();
    if (!this.isEnabled(config)) {
      this.setStatus({ enabled: false, ready: false, reason: 'disabled' });
      return;
    }
    this.setStatus({ enabled: true, ready: false, reason: 'not_ready' });

    const ensured = await this.supervisor().ensureRunning();
    if (!ensured.ok) {
      const reason = isFailureReason(ensured.reason) ? ensured.reason : 'not_ready';
      this.setStatus({ enabled: true, ready: false, reason });
      this.warn(`sidecar unavailable (${reason})${ensured.message ? `: ${ensured.message}` : ''}`);
      return;
    }

    // Version is validated here as well as in the supervisor: `start()` is the contract
    // point that a decision made later was produced by the model the config expects.
    const health = await this.client().health(config.service.requestTimeoutMs);
    if (!isBiodHealthReady(health)) {
      this.setStatus({ enabled: true, ready: false, reason: 'not_ready' });
      this.warn(`sidecar is running but not ready${health.error ? `: ${health.error}` : ''}`);
      return;
    }
    if (!matchesBiodModelVersion(health.modelVersion, config.model.expectedVersion)) {
      this.setStatus({ enabled: true, ready: false, reason: 'model_mismatch', modelVersion: health.modelVersion });
      this.warn(`model version mismatch: sidecar "${health.modelVersion ?? 'unknown'}", expected "${config.model.expectedVersion}"`);
      return;
    }

    const version = await this.client().version();
    if (version.ok && version.optionIds) {
      this.vocab = { tool: new Set(version.optionIds.tool), kb: new Set(version.optionIds.kb) };
    }
    this.setStatus({ enabled: true, ready: true, modelVersion: health.modelVersion });
    const adopted = isAdopted(this.supervisor());
    this.log(`ready (model ${health.modelVersion ?? 'unknown'}${adopted ? ', adopted existing sidecar' : ''})`);
  }

  /** Drop candidates the checkpoint was not trained on; an unknown id would fail the whole decision. */
  private maskCandidates(kind: 'tool' | 'kb', candidates: BiodCandidate[]): BiodCandidate[] {
    const known = this.vocab?.[kind];
    if (!known || !known.size) return candidates;
    return candidates.filter((candidate) => known.has(candidate.id));
  }

  private guardDecision(point: BiodDecisionPoint, state: string): DecisionGuard {
    const config = this.config();
    if (!this.isEnabled(config)) {
      return { ok: false, failure: { ok: false, reason: 'disabled', message: 'biod is disabled' } };
    }
    if (config.decisionPoints[point].mode === 'off') {
      return { ok: false, failure: { ok: false, reason: 'disabled', message: `biod decision point ${point} is off` } };
    }
    const text = typeof state === 'string' ? state : '';
    if (!text.trim()) {
      return { ok: false, failure: { ok: false, reason: 'not_ready', message: 'empty state text' } };
    }
    if (!this.status.ready) {
      // Before `start()` the default status says "disabled" because the feature switch has
      // not been consulted yet; an enabled config that simply has not started is not_ready.
      const reason: BiodFailureReason =
        this.status.reason === 'disabled' && this.isEnabled(config) ? 'not_ready' : this.status.reason ?? 'not_ready';
      return { ok: false, failure: { ok: false, reason, message: 'biod is not ready' } };
    }
    return { ok: true, state: text };
  }

  private async callClient<T extends { ok: true }>(
    kind: DecisionKind,
    state: string,
    call: () => Promise<BiodResult<T>>,
  ): Promise<BiodResult<T>> {
    try {
      return await call();
    } catch (error) {
      // Clients are written to never throw; a test seam or a future backend still must not
      // take the run down with it.
      this.warn(`${kind} decision threw: ${describeError(error)}`);
      return { ok: false, reason: 'bad_response', message: describeError(error) };
    }
  }

  private recordDecision(kind: DecisionKind, state: string, result: BiodResult<unknown>): void {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      kind,
      ok: isSuccess(result),
      stateChars: state.length,
    };
    if (isSuccess(result)) {
      const decision = result as {
        decisionId?: string;
        chosen?: string[];
        confidence?: number;
        latencyMs?: number;
        modelVersion?: string;
        candidateCount?: number;
        scores?: unknown[];
      };
      entry.decisionId = decision.decisionId ?? null;
      entry.chosen = decision.chosen ?? null;
      entry.confidence = decision.confidence ?? null;
      entry.latencyMs = decision.latencyMs ?? null;
      entry.modelVersion = decision.modelVersion ?? null;
      entry.candidateCount = decision.candidateCount ?? decision.scores?.length ?? null;
    } else {
      entry.reason = (result as BiodFailure).reason;
      entry.message = (result as BiodFailure).message ?? null;
    }
    this.appendDecision(entry);
  }

  private recordFailure(kind: DecisionKind, state: string, failure: BiodFailure): void {
    this.appendDecision({
      ts: new Date().toISOString(),
      kind,
      ok: false,
      stateChars: typeof state === 'string' ? state.length : 0,
      reason: failure.reason,
      message: failure.message ?? null,
    });
  }

  private appendDecision(entry: Record<string, unknown>): void {
    // The audit log is diagnostics: a read-only or missing workspace must never fail a call.
    try {
      fs.mkdirSync(path.dirname(this.decisionsFile), { recursive: true });
      fs.appendFileSync(this.decisionsFile, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // ignore
    }
  }

  private config(): BiodConfig {
    if (!this.configCache) this.configCache = loadBiodConfig();
    return this.configCache;
  }

  private client(): BiodClient {
    if (!this.clientCache) {
      if (this.providedClient) {
        this.clientCache = this.providedClient;
      } else {
        const config = this.config();
        this.clientCache = new HttpBiodClient({
          baseUrl: config.service.baseUrl,
          requestTimeoutMs: config.service.requestTimeoutMs,
          contextTimeoutMs: config.service.contextTimeoutMs,
        });
      }
    }
    return this.clientCache;
  }

  private supervisor(): BiodSupervisorLike {
    if (!this.supervisorCache) {
      if (this.providedSupervisor) {
        this.supervisorCache = this.providedSupervisor;
      } else {
        this.supervisorCache = new BiodProcessSupervisor({ config: this.config(), probe: this.client() });
      }
    }
    return this.supervisorCache;
  }

  private isEnabled(config: BiodConfig): boolean {
    return config.enabled && !isBiodDisabledByEnv(this.environment);
  }

  private setStatus(status: BiodServiceStatus): void {
    this.status = status;
  }

  private log(message: string): void {
    console.log(`[biod] ${message}`);
  }

  private warn(message: string): void {
    console.warn(`[biod] ${message}`);
  }
}

/** The process-wide singleton. Consumers may inject their own instance in tests. */
export const biodService = new BiodService();

function isSuccess(result: BiodResult<unknown>): boolean {
  return (result as { ok?: unknown }).ok === true;
}

function isAdopted(supervisor: BiodSupervisorLike): boolean {
  return Boolean((supervisor as { adopted?: unknown }).adopted);
}

const FAILURE_REASONS: readonly BiodFailureReason[] = [
  'disabled',
  'not_configured',
  'not_ready',
  'timeout',
  'network',
  'bad_response',
  'catalog_mismatch',
  'circuit_open',
  'model_mismatch',
];

function isFailureReason(value: unknown): value is BiodFailureReason {
  return typeof value === 'string' && (FAILURE_REASONS as readonly string[]).includes(value);
}

function emptyScreenResult(): SearcherScreenResult {
  return { decisions: [], premiseVerdicts: [], shortlist: [], ranked: [], deferred: [], exploration: [], fallback: true };
}

type SearcherScreenMode = 'off' | 'shadow' | 'assist';

/** S2 runs as one unit: any assisted core DP opens assist; otherwise shadow/off. */
function effectiveSearcherMode(framework: BiodFrameworkConfig): SearcherScreenMode {
  const modes = [
    normalizeSearcherMode(framework.decisionPoints['s2.premise']?.mode, framework.defaultMode),
    normalizeSearcherMode(framework.decisionPoints['s2.rerank']?.mode, framework.defaultMode),
    normalizeSearcherMode(framework.decisionPoints['s2.policy']?.mode, framework.defaultMode),
  ];
  if (modes.includes('assist')) return 'assist';
  if (modes.includes('shadow')) return 'shadow';
  return 'off';
}

function normalizeSearcherMode(mode: Mode | undefined, fallback: Mode): SearcherScreenMode {
  const value = mode ?? fallback;
  return value === 'assist' || value === 'shadow' ? value : 'off';
}

function supportingSearcherMode(
  framework: BiodFrameworkConfig,
  key: 's3.trigger' | 's5.diversity',
  allowed: readonly Mode[],
): Mode {
  const mode = framework.decisionPoints[key]?.mode ?? 'off';
  return allowed.includes(mode) ? mode : 'off';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
