import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_ROOT } from '../../paths.js';
import { interpolateEnvironment } from '../config/secret_config.js';
import {
  DEFAULT_PLAN_AUDIT_PREFILTER,
  DEFAULT_PLAN_AUDIT_THRESHOLDS,
  type PlanAuditPrefilter,
  type PlanAuditThresholds,
} from './researcher/contracts.js';
import {
  DEFAULT_ISSUE_TRIAGE_THRESHOLDS,
  type IssueTriageThresholds,
} from './reviewer/contracts.js';
import {
  DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS,
  DEFAULT_MANUSCRIPT_PRECHECK,
  type ManuscriptAuditThresholds,
  type ManuscriptPrecheckConfig,
} from './writer/contracts.js';

/**
 * Reads `biod.json` into the one shape the decision layer needs.
 *
 * Configuration is treated as untrusted input: a missing file, a syntax error or a field
 * of the wrong type must never stop the backend from booting. The result is always a
 * complete `BiodConfig`; anything the loader had to correct is reported in `warnings`
 * instead of being silently defaulted or thrown. Unknown fields are warnings too — a typo
 * such as `maxChar` (for `maxChars`) must be visible, not quietly ignored.
 */

export const BIOD_CONFIG_FILE = 'biod.json';

export type BiodDecisionPointMode = 'off' | 'select';

export interface BiodServiceConfig {
  baseUrl: string;
  autoStart: boolean;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  contextTimeoutMs: number;
  /** Timeout for `/v1/score-pairs` role-head calls (H6/H7); defaults to 8000. */
  pairTimeoutMs: number;
}

export interface BiodRuntimeConfig {
  /** Python module launched as the sidecar; defaults to `biod.serve` (v0). */
  entry?: string;
  /** Interpreter used to launch `python -m biod.serve`; DSPy repo + checkpoint below. */
  python?: string;
  repoRoot?: string;
  ckptDir?: string;
  device: string;
  dtype: string;
  hfHome?: string;
}

export interface BiodModelConfig {
  /** The sidecar may append a build suffix, so this is a "contains" check. */
  expectedVersion: string;
}

export interface BiodToolSelectConfig {
  mode: BiodDecisionPointMode;
  tau: number;
}

export interface BiodKbSelectConfig {
  mode: BiodDecisionPointMode;
  tau: number;
  topK: number;
}

export interface BiodContextRetentionConfig {
  mode: BiodDecisionPointMode;
  maxGroups: number;
}

export interface BiodRoleSelectConfig {
  mode: BiodDecisionPointMode;
  tau: number;
}

export interface BiodRelaySelectConfig {
  mode: BiodDecisionPointMode;
  floor: number;
}

export interface BiodDecisionPointsConfig {
  tool_select: BiodToolSelectConfig;
  kb_select: BiodKbSelectConfig;
  context_retention: BiodContextRetentionConfig;
  role_select: BiodRoleSelectConfig;
  relay_select: BiodRelaySelectConfig;
}

export type BiodFrameworkMode = 'off' | 'shadow' | 'assist' | 'guard' | 'trigger' | 'cascade';
export type BiodFrameworkBudget =
  | 'rule'
  | 'short'
  | 'medium'
  | 'long'
  | 'max'
  | 'audit'
  | 'audit-max'
  | 'claim-audit'
  | 'claim-audit-max'
  | 'issue-audit'
  | 'issue-audit-max';

export interface BiodFrameworkDecisionPointConfig {
  mode?: BiodFrameworkMode;
  scorer?: string;
  budget?: BiodFrameworkBudget;
}

export interface BiodResearcherFrameworkConfig {
  enabled: boolean;
  thresholds: PlanAuditThresholds;
  prefilter: PlanAuditPrefilter;
  decisionPoints: Partial<Record<'r1.plan-audit', BiodFrameworkDecisionPointConfig>>;
}

export interface BiodWriterFrameworkConfig {
  enabled: boolean;
  thresholds: ManuscriptAuditThresholds;
  precheck: ManuscriptPrecheckConfig;
  decisionPoints: Partial<Record<'w1.claim-evidence-audit', BiodFrameworkDecisionPointConfig>>;
}

export interface BiodReviewerFrameworkConfig {
  enabled: boolean;
  thresholds: IssueTriageThresholds;
  decisionPoints: Partial<Record<'v1.issue-triage', BiodFrameworkDecisionPointConfig>>;
}

export interface BiodFrameworkConfig {
  enabled: boolean;
  defaultMode: BiodFrameworkMode;
  decisionPoints: Partial<Record<'s2.premise' | 's2.rerank' | 's2.policy' | 's3.trigger' | 's5.diversity', BiodFrameworkDecisionPointConfig>>;
  researcher?: BiodResearcherFrameworkConfig;
  writer?: BiodWriterFrameworkConfig;
  reviewer?: BiodReviewerFrameworkConfig;
}

export interface BiodConfig {
  enabled: boolean;
  service: BiodServiceConfig;
  runtime: BiodRuntimeConfig;
  model: BiodModelConfig;
  decisionPoints: BiodDecisionPointsConfig;
  framework?: BiodFrameworkConfig;
  state: { maxChars: number };
  /** Loader corrections and unknown fields. Empty for a fully valid file. */
  warnings: string[];
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8790';
const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_CONTEXT_TIMEOUT_MS = 3_000;
const DEFAULT_PAIR_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_STATE_CHARS = 2_000;

const TOP_LEVEL_KEYS = ['schemaVersion', 'enabled', 'service', 'runtime', 'model', 'decisionPoints', 'framework', 'state'] as const;
const SERVICE_KEYS = ['baseUrl', 'autoStart', 'startupTimeoutMs', 'requestTimeoutMs', 'contextTimeoutMs', 'pairTimeoutMs'] as const;
const RUNTIME_KEYS = ['entry', 'python', 'repoRoot', 'ckptDir', 'device', 'dtype', 'hfHome'] as const;
const MODEL_KEYS = ['expectedVersion'] as const;
const DECISION_POINT_KEYS = ['tool_select', 'kb_select', 'context_retention', 'role_select', 'relay_select'] as const;
const TOOL_SELECT_KEYS = ['mode', 'tau'] as const;
const KB_SELECT_KEYS = ['mode', 'tau', 'topK'] as const;
const CONTEXT_RETENTION_KEYS = ['mode', 'maxGroups'] as const;
const ROLE_SELECT_KEYS = ['mode', 'tau'] as const;
const RELAY_SELECT_KEYS = ['mode', 'floor'] as const;
const STATE_KEYS = ['maxChars'] as const;

/**
 * Disabled, autostart-off, decision points off: what the runtime gets when the file is
 * missing or unreadable. Falls back to the pre-biod behaviour instead of failing a run.
 */
function safeDefaults(): BiodConfig {
  return {
    enabled: false,
    service: {
      baseUrl: DEFAULT_BASE_URL,
      autoStart: false,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      contextTimeoutMs: DEFAULT_CONTEXT_TIMEOUT_MS,
      pairTimeoutMs: DEFAULT_PAIR_TIMEOUT_MS,
    },
    runtime: { device: 'cuda', dtype: 'bfloat16' },
    model: { expectedVersion: 'biod-v0-final' },
    decisionPoints: {
      tool_select: { mode: 'off', tau: 0.5 },
      kb_select: { mode: 'off', tau: 0.5, topK: 3 },
      context_retention: { mode: 'off', maxGroups: 32 },
      role_select: { mode: 'off', tau: 0.6 },
      relay_select: { mode: 'off', floor: 0.75 },
    },
    framework: {
      enabled: false,
      defaultMode: 'off',
      decisionPoints: {},
      researcher: {
        enabled: false,
        thresholds: { ...DEFAULT_PLAN_AUDIT_THRESHOLDS },
        prefilter: { ...DEFAULT_PLAN_AUDIT_PREFILTER },
        decisionPoints: {},
      },
      writer: {
        enabled: false,
        thresholds: { ...DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS },
        precheck: { ...DEFAULT_MANUSCRIPT_PRECHECK },
        decisionPoints: {},
      },
      reviewer: {
        enabled: false,
        thresholds: { ...DEFAULT_ISSUE_TRIAGE_THRESHOLDS },
        decisionPoints: {},
      },
    },
    state: { maxChars: DEFAULT_MAX_STATE_CHARS },
    warnings: [],
  };
}

/**
 * `directory` defaults to `BIOFLOW_CONFIG_DIR || CONFIG_ROOT`. The environment parameter
 * exists so tests (and the web config editor) can resolve `${ENV}` references against a
 * known map instead of the process environment.
 */
export function loadBiodConfig(
  directory: string = process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT,
  environment: NodeJS.ProcessEnv = process.env,
): BiodConfig {
  const config = safeDefaults();
  const file = path.join(directory, BIOD_CONFIG_FILE);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    config.warnings.push(`${file}: ${describeError(error)}; using the disabled safe default.`);
    return config;
  }
  if (!isRecord(raw)) {
    config.warnings.push(`${file}: the top-level value must be a JSON object; using the disabled safe default.`);
    return config;
  }

  collectUnknownKeys(raw, TOP_LEVEL_KEYS, 'biod', config.warnings);
  config.enabled = booleanValue(raw.enabled, false, 'biod.enabled', config.warnings);
  readService(raw.service, config, environment);
  readRuntime(raw.runtime, config, environment);
  readModel(raw.model, config, environment);
  readDecisionPoints(raw.decisionPoints, config);
  readFramework(raw.framework, config, config.warnings);
  readState(raw.state, config, config.warnings);

  if (config.enabled && !isBiodRuntimeConfigured(config.runtime)) {
    // An enabled config without a complete runtime can still talk to an already-running
    // sidecar; it just must not try to launch one it cannot describe.
    config.service.autoStart = false;
    config.warnings.push(
      'biod.runtime.python/repoRoot/ckptDir is incomplete: autoStart is disabled. A running sidecar can still be adopted.',
    );
  }
  return config;
}

export function isBiodDisabledByEnv(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(environment.BIOFLOW_BIOD_DISABLED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** `python`, `repoRoot` and `ckptDir` are all required to launch the sidecar ourselves. */
export function isBiodRuntimeConfigured(
  runtime: BiodRuntimeConfig,
): runtime is BiodRuntimeConfig & { python: string; repoRoot: string; ckptDir: string } {
  return Boolean(runtime.python && runtime.repoRoot && runtime.ckptDir);
}

/** The sidecar reports e.g. `biod-v0-final+abc123`; the configured name is a prefix. */
export function matchesBiodModelVersion(actual: string | undefined, expected: string | undefined): boolean {
  const wanted = String(expected ?? '').trim();
  if (!wanted) return true;
  const observed = String(actual ?? '').trim();
  if (!observed) return false;
  return observed === wanted || observed.includes(wanted);
}

function readService(value: unknown, config: BiodConfig, environment: NodeJS.ProcessEnv): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    config.warnings.push('biod.service: expected an object; using defaults.');
    return;
  }
  collectUnknownKeys(value, SERVICE_KEYS, 'biod.service', config.warnings);
  const baseUrl = textValue(value.baseUrl, 'biod.service.baseUrl', environment, config.warnings);
  if (baseUrl !== undefined) {
    if (isHttpUrl(baseUrl)) config.service.baseUrl = baseUrl.replace(/\/+$/, '');
    else config.warnings.push(`biod.service.baseUrl: "${baseUrl}" is not an http(s) URL; using ${DEFAULT_BASE_URL}.`);
  }
  config.service.autoStart = booleanValue(value.autoStart, config.service.autoStart, 'biod.service.autoStart', config.warnings);
  config.service.startupTimeoutMs = integerValue(
    value.startupTimeoutMs,
    config.service.startupTimeoutMs,
    { min: 1_000, max: 3_600_000 },
    'biod.service.startupTimeoutMs',
    config.warnings,
  );
  config.service.requestTimeoutMs = integerValue(
    value.requestTimeoutMs,
    config.service.requestTimeoutMs,
    { min: 50, max: 600_000 },
    'biod.service.requestTimeoutMs',
    config.warnings,
  );
  config.service.contextTimeoutMs = integerValue(
    value.contextTimeoutMs,
    config.service.contextTimeoutMs,
    { min: 50, max: 600_000 },
    'biod.service.contextTimeoutMs',
    config.warnings,
  );
  config.service.pairTimeoutMs = integerValue(
    value.pairTimeoutMs,
    config.service.pairTimeoutMs,
    { min: 50, max: 600_000 },
    'biod.service.pairTimeoutMs',
    config.warnings,
  );
}

function readRuntime(value: unknown, config: BiodConfig, environment: NodeJS.ProcessEnv): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    config.warnings.push('biod.runtime: expected an object; using defaults.');
    return;
  }
  collectUnknownKeys(value, RUNTIME_KEYS, 'biod.runtime', config.warnings);
  config.runtime.entry = textValue(value.entry, 'biod.runtime.entry', environment, config.warnings);
  config.runtime.python = textValue(value.python, 'biod.runtime.python', environment, config.warnings);
  config.runtime.repoRoot = textValue(value.repoRoot, 'biod.runtime.repoRoot', environment, config.warnings);
  config.runtime.ckptDir = textValue(value.ckptDir, 'biod.runtime.ckptDir', environment, config.warnings);
  config.runtime.hfHome = textValue(value.hfHome, 'biod.runtime.hfHome', environment, config.warnings);
  const device = textValue(value.device, 'biod.runtime.device', environment, config.warnings);
  if (device !== undefined) config.runtime.device = device;
  const dtype = textValue(value.dtype, 'biod.runtime.dtype', environment, config.warnings);
  if (dtype !== undefined) config.runtime.dtype = dtype;
}

function readModel(value: unknown, config: BiodConfig, environment: NodeJS.ProcessEnv): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    config.warnings.push('biod.model: expected an object; using defaults.');
    return;
  }
  collectUnknownKeys(value, MODEL_KEYS, 'biod.model', config.warnings);
  const expected = textValue(value.expectedVersion, 'biod.model.expectedVersion', environment, config.warnings);
  if (expected !== undefined) config.model.expectedVersion = expected;
}

function readDecisionPoints(value: unknown, config: BiodConfig): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    config.warnings.push('biod.decisionPoints: expected an object; every decision point stays off.');
    return;
  }
  collectUnknownKeys(value, DECISION_POINT_KEYS, 'biod.decisionPoints', config.warnings);

  const tool = readDecisionPoint(value.tool_select, 'tool_select', TOOL_SELECT_KEYS, config.warnings);
  if (tool) {
    config.decisionPoints.tool_select.mode = modeValue(tool.mode, config.decisionPoints.tool_select.mode, 'biod.decisionPoints.tool_select.mode', config.warnings);
    config.decisionPoints.tool_select.tau = unitInterval(tool.tau, config.decisionPoints.tool_select.tau, 'biod.decisionPoints.tool_select.tau', config.warnings);
  }

  const kb = readDecisionPoint(value.kb_select, 'kb_select', KB_SELECT_KEYS, config.warnings);
  if (kb) {
    config.decisionPoints.kb_select.mode = modeValue(kb.mode, config.decisionPoints.kb_select.mode, 'biod.decisionPoints.kb_select.mode', config.warnings);
    config.decisionPoints.kb_select.tau = unitInterval(kb.tau, config.decisionPoints.kb_select.tau, 'biod.decisionPoints.kb_select.tau', config.warnings);
    config.decisionPoints.kb_select.topK = integerValue(
      kb.topK,
      config.decisionPoints.kb_select.topK,
      { min: 1, max: 64 },
      'biod.decisionPoints.kb_select.topK',
      config.warnings,
    );
  }

  const context = readDecisionPoint(value.context_retention, 'context_retention', CONTEXT_RETENTION_KEYS, config.warnings);
  if (context) {
    config.decisionPoints.context_retention.mode = modeValue(
      context.mode,
      config.decisionPoints.context_retention.mode,
      'biod.decisionPoints.context_retention.mode',
      config.warnings,
    );
    config.decisionPoints.context_retention.maxGroups = integerValue(
      context.maxGroups,
      config.decisionPoints.context_retention.maxGroups,
      { min: 1, max: 256 },
      'biod.decisionPoints.context_retention.maxGroups',
      config.warnings,
    );
  }

  const role = readDecisionPoint(value.role_select, 'role_select', ROLE_SELECT_KEYS, config.warnings);
  if (role) {
    config.decisionPoints.role_select.mode = modeValue(role.mode, config.decisionPoints.role_select.mode, 'biod.decisionPoints.role_select.mode', config.warnings);
    config.decisionPoints.role_select.tau = unitInterval(role.tau, config.decisionPoints.role_select.tau, 'biod.decisionPoints.role_select.tau', config.warnings);
  }

  const relay = readDecisionPoint(value.relay_select, 'relay_select', RELAY_SELECT_KEYS, config.warnings);
  if (relay) {
    config.decisionPoints.relay_select.mode = modeValue(relay.mode, config.decisionPoints.relay_select.mode, 'biod.decisionPoints.relay_select.mode', config.warnings);
    config.decisionPoints.relay_select.floor = unitInterval(relay.floor, config.decisionPoints.relay_select.floor, 'biod.decisionPoints.relay_select.floor', config.warnings);
  }
}

function readDecisionPoint(
  value: unknown,
  name: string,
  allowedKeys: readonly string[],
  warnings: string[],
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`biod.decisionPoints.${name}: expected an object; the decision point stays off.`);
    return undefined;
  }
  collectUnknownKeys(value, allowedKeys, `biod.decisionPoints.${name}`, warnings);
  return value;
}

function readFramework(value: unknown, config: BiodConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    warnings.push('biod.framework: expected an object; framework stays off.');
    return;
  }
  collectUnknownKeys(value, ['enabled', 'defaultMode', 'decisionPoints', 'researcher', 'writer', 'reviewer'], 'biod.framework', warnings);
  const enabled = booleanValue(value.enabled, false, 'biod.framework.enabled', warnings);
  const defaultMode = frameworkMode(value.defaultMode, 'off', 'biod.framework.defaultMode', warnings);
  const points: BiodFrameworkConfig['decisionPoints'] = {};
  if (isRecord(value.decisionPoints)) {
    for (const key of ['s2.premise', 's2.rerank', 's2.policy', 's3.trigger', 's5.diversity'] as const) {
      const point = value.decisionPoints[key];
      if (point === undefined) continue;
      if (!isRecord(point)) {
        warnings.push(`biod.framework.decisionPoints.${key}: expected an object; ignored.`);
        continue;
      }
      collectUnknownKeys(point, ['mode', 'scorer', 'budget'], `biod.framework.decisionPoints.${key}`, warnings);
      points[key] = {
        mode: frameworkMode(point.mode, defaultMode, `biod.framework.decisionPoints.${key}.mode`, warnings),
        scorer: typeof point.scorer === 'string' ? point.scorer : undefined,
        budget: frameworkBudget(point.budget, `biod.framework.decisionPoints.${key}.budget`, warnings),
      };
    }
  } else if (value.decisionPoints !== undefined) {
    warnings.push('biod.framework.decisionPoints: expected an object; ignored.');
  }
  const researcher = readResearcherFramework(value.researcher, defaultMode, warnings);
  const writer = readWriterFramework(value.writer, defaultMode, warnings);
  const reviewer = readReviewerFramework(value.reviewer, defaultMode, warnings);
  config.framework = {
    enabled,
    defaultMode,
    decisionPoints: points,
    ...(researcher ? { researcher } : {}),
    ...(writer ? { writer } : {}),
    ...(reviewer ? { reviewer } : {}),
  };
}

function readResearcherFramework(
  value: unknown,
  defaultMode: BiodFrameworkMode,
  warnings: string[],
): BiodResearcherFrameworkConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push('biod.framework.researcher: expected an object; ignored.');
    return undefined;
  }
  collectUnknownKeys(
    value,
    ['enabled', 'thresholds', 'prefilter', 'decisionPoints'],
    'biod.framework.researcher',
    warnings,
  );
  const enabled = booleanValue(value.enabled, false, 'biod.framework.researcher.enabled', warnings);
  const thresholds = readResearcherThresholds(value.thresholds, warnings);
  const prefilter = readResearcherPrefilter(value.prefilter, warnings);
  const decisionPoints: BiodResearcherFrameworkConfig['decisionPoints'] = {};
  if (isRecord(value.decisionPoints)) {
    collectUnknownKeys(value.decisionPoints, ['r1.plan-audit'], 'biod.framework.researcher.decisionPoints', warnings);
    const point = value.decisionPoints['r1.plan-audit'];
    if (point !== undefined) {
      const parsed = readResearcherDecisionPoint(point, defaultMode, warnings);
      if (parsed) decisionPoints['r1.plan-audit'] = parsed;
    }
  } else if (value.decisionPoints !== undefined) {
    warnings.push('biod.framework.researcher.decisionPoints: expected an object; ignored.');
  }
  return { enabled, thresholds, prefilter, decisionPoints };
}

const RESEARCHER_THRESHOLD_KEYS = ['tauBetter', 'tauMissing', 'margin', 'minConfidence', 'topK'] as const;
const RESEARCHER_PREFILTER_KEYS = ['mode', 'maxCandidates'] as const;

function readResearcherThresholds(value: unknown, warnings: string[]): PlanAuditThresholds {
  const defaults = { ...DEFAULT_PLAN_AUDIT_THRESHOLDS };
  if (value === undefined) return defaults;
  if (!isRecord(value)) {
    warnings.push('biod.framework.researcher.thresholds: expected an object; using defaults.');
    return defaults;
  }
  collectUnknownKeys(value, RESEARCHER_THRESHOLD_KEYS, 'biod.framework.researcher.thresholds', warnings);
  return {
    tauBetter: unitInterval(value.tauBetter, defaults.tauBetter, 'biod.framework.researcher.thresholds.tauBetter', warnings),
    tauMissing: unitInterval(value.tauMissing, defaults.tauMissing, 'biod.framework.researcher.thresholds.tauMissing', warnings),
    margin: unitInterval(value.margin, defaults.margin, 'biod.framework.researcher.thresholds.margin', warnings),
    minConfidence: unitInterval(value.minConfidence, defaults.minConfidence, 'biod.framework.researcher.thresholds.minConfidence', warnings),
    topK: integerValue(value.topK, defaults.topK, { min: 1, max: 20 }, 'biod.framework.researcher.thresholds.topK', warnings),
  };
}

function readResearcherPrefilter(value: unknown, warnings: string[]): PlanAuditPrefilter {
  const defaults = { ...DEFAULT_PLAN_AUDIT_PREFILTER };
  if (value === undefined) return defaults;
  if (!isRecord(value)) {
    warnings.push('biod.framework.researcher.prefilter: expected an object; using defaults.');
    return defaults;
  }
  collectUnknownKeys(value, RESEARCHER_PREFILTER_KEYS, 'biod.framework.researcher.prefilter', warnings);
  const mode = value.mode === 'none' || value.mode === 'lexical' ? value.mode : undefined;
  if (value.mode !== undefined && mode === undefined) {
    warnings.push('biod.framework.researcher.prefilter.mode: expected "lexical" or "none"; using "lexical".');
  }
  return {
    mode: mode ?? defaults.mode,
    maxCandidates: integerValue(
      value.maxCandidates,
      defaults.maxCandidates,
      { min: 2, max: 128 },
      'biod.framework.researcher.prefilter.maxCandidates',
      warnings,
    ),
  };
}

function readResearcherDecisionPoint(
  value: unknown,
  defaultMode: BiodFrameworkMode,
  warnings: string[],
): BiodFrameworkDecisionPointConfig | undefined {
  if (!isRecord(value)) {
    warnings.push('biod.framework.researcher.decisionPoints.r1.plan-audit: expected an object; ignored.');
    return undefined;
  }
  collectUnknownKeys(value, ['mode', 'scorer', 'budget'], 'biod.framework.researcher.decisionPoints.r1.plan-audit', warnings);
  const parsedMode = frameworkMode(
    value.mode,
    defaultMode,
    'biod.framework.researcher.decisionPoints.r1.plan-audit.mode',
    warnings,
  );
  const mode: BiodFrameworkMode = parsedMode === 'off' || parsedMode === 'shadow' || parsedMode === 'assist'
    ? parsedMode
    : 'off';
  if (parsedMode !== mode) {
    warnings.push('biod.framework.researcher.decisionPoints.r1.plan-audit.mode: only off/shadow/assist are supported; using "off".');
  }
  return {
    mode,
    scorer: typeof value.scorer === 'string' ? value.scorer : undefined,
    budget: frameworkBudget(value.budget, 'biod.framework.researcher.decisionPoints.r1.plan-audit.budget', warnings),
  };
}

function readWriterFramework(
  value: unknown,
  defaultMode: BiodFrameworkMode,
  warnings: string[],
): BiodWriterFrameworkConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push('biod.framework.writer: expected an object; ignored.');
    return undefined;
  }
  collectUnknownKeys(
    value,
    ['enabled', 'thresholds', 'precheck', 'decisionPoints'],
    'biod.framework.writer',
    warnings,
  );
  const enabled = booleanValue(value.enabled, false, 'biod.framework.writer.enabled', warnings);
  const thresholds = readWriterThresholds(value.thresholds, warnings);
  const precheck = readWriterPrecheck(value.precheck, warnings);
  const decisionPoints: BiodWriterFrameworkConfig['decisionPoints'] = {};
  if (isRecord(value.decisionPoints)) {
    collectUnknownKeys(value.decisionPoints, ['w1.claim-evidence-audit'], 'biod.framework.writer.decisionPoints', warnings);
    const point = value.decisionPoints['w1.claim-evidence-audit'];
    if (point !== undefined) {
      const parsed = readWriterDecisionPoint(point, defaultMode, warnings);
      if (parsed) decisionPoints['w1.claim-evidence-audit'] = parsed;
    }
  } else if (value.decisionPoints !== undefined) {
    warnings.push('biod.framework.writer.decisionPoints: expected an object; ignored.');
  }
  return { enabled, thresholds, precheck, decisionPoints };
}

const WRITER_THRESHOLD_KEYS = ['minConfidence', 'tauMismatch', 'tauPartial', 'overclaimConfidence', 'topIssues'] as const;
const WRITER_PRECHECK_KEYS = ['online', 'maxQuoteChars'] as const;

function readWriterThresholds(value: unknown, warnings: string[]): ManuscriptAuditThresholds {
  const defaults = { ...DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS };
  if (value === undefined) return defaults;
  if (!isRecord(value)) {
    warnings.push('biod.framework.writer.thresholds: expected an object; using defaults.');
    return defaults;
  }
  collectUnknownKeys(value, WRITER_THRESHOLD_KEYS, 'biod.framework.writer.thresholds', warnings);
  return {
    minConfidence: unitInterval(value.minConfidence, defaults.minConfidence, 'biod.framework.writer.thresholds.minConfidence', warnings),
    tauMismatch: unitInterval(value.tauMismatch, defaults.tauMismatch, 'biod.framework.writer.thresholds.tauMismatch', warnings),
    tauPartial: unitInterval(value.tauPartial, defaults.tauPartial, 'biod.framework.writer.thresholds.tauPartial', warnings),
    overclaimConfidence: unitInterval(value.overclaimConfidence, defaults.overclaimConfidence, 'biod.framework.writer.thresholds.overclaimConfidence', warnings),
    topIssues: integerValue(value.topIssues, defaults.topIssues, { min: 1, max: 50 }, 'biod.framework.writer.thresholds.topIssues', warnings),
  };
}

function readWriterPrecheck(value: unknown, warnings: string[]): ManuscriptPrecheckConfig {
  const defaults = { ...DEFAULT_MANUSCRIPT_PRECHECK };
  if (value === undefined) return defaults;
  if (!isRecord(value)) {
    warnings.push('biod.framework.writer.precheck: expected an object; using defaults.');
    return defaults;
  }
  collectUnknownKeys(value, WRITER_PRECHECK_KEYS, 'biod.framework.writer.precheck', warnings);
  return {
    online: booleanValue(value.online, defaults.online, 'biod.framework.writer.precheck.online', warnings),
    maxQuoteChars: integerValue(
      value.maxQuoteChars,
      defaults.maxQuoteChars,
      { min: 100, max: 4_000 },
      'biod.framework.writer.precheck.maxQuoteChars',
      warnings,
    ),
  };
}

function readWriterDecisionPoint(
  value: unknown,
  defaultMode: BiodFrameworkMode,
  warnings: string[],
): BiodFrameworkDecisionPointConfig | undefined {
  if (!isRecord(value)) {
    warnings.push('biod.framework.writer.decisionPoints.w1.claim-evidence-audit: expected an object; ignored.');
    return undefined;
  }
  collectUnknownKeys(value, ['mode', 'scorer', 'budget'], 'biod.framework.writer.decisionPoints.w1.claim-evidence-audit', warnings);
  const parsedMode = frameworkMode(
    value.mode,
    defaultMode,
    'biod.framework.writer.decisionPoints.w1.claim-evidence-audit.mode',
    warnings,
  );
  const mode: BiodFrameworkMode = parsedMode === 'off' || parsedMode === 'shadow' || parsedMode === 'assist'
    ? parsedMode
    : 'off';
  if (parsedMode !== mode) {
    warnings.push('biod.framework.writer.decisionPoints.w1.claim-evidence-audit.mode: only off/shadow/assist are supported; using "off".');
  }
  return {
    mode,
    scorer: typeof value.scorer === 'string' ? value.scorer : undefined,
    budget: frameworkBudget(value.budget, 'biod.framework.writer.decisionPoints.w1.claim-evidence-audit.budget', warnings),
  };
}

function readReviewerFramework(
  value: unknown,
  defaultMode: BiodFrameworkMode,
  warnings: string[],
): BiodReviewerFrameworkConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push('biod.framework.reviewer: expected an object; ignored.');
    return undefined;
  }
  collectUnknownKeys(
    value,
    ['enabled', 'thresholds', 'decisionPoints'],
    'biod.framework.reviewer',
    warnings,
  );
  const enabled = booleanValue(value.enabled, false, 'biod.framework.reviewer.enabled', warnings);
  const thresholds = readReviewerThresholds(value.thresholds, warnings);
  const decisionPoints: BiodReviewerFrameworkConfig['decisionPoints'] = {};
  if (isRecord(value.decisionPoints)) {
    collectUnknownKeys(value.decisionPoints, ['v1.issue-triage'], 'biod.framework.reviewer.decisionPoints', warnings);
    const point = value.decisionPoints['v1.issue-triage'];
    if (point !== undefined) {
      const parsed = readReviewerDecisionPoint(point, defaultMode, warnings);
      if (parsed) decisionPoints['v1.issue-triage'] = parsed;
    }
  } else if (value.decisionPoints !== undefined) {
    warnings.push('biod.framework.reviewer.decisionPoints: expected an object; ignored.');
  }
  return { enabled, thresholds, decisionPoints };
}

const REVIEWER_THRESHOLD_KEYS = [
  'minConfidence',
  'tauContradicted',
  'tauHolds',
  'ownerMargin',
  'pairMargin',
  'duplicateThreshold',
  'maxPairwiseIssues',
  'maxScoredIssues',
  'topIssues',
] as const;

function readReviewerThresholds(value: unknown, warnings: string[]): IssueTriageThresholds {
  const defaults = { ...DEFAULT_ISSUE_TRIAGE_THRESHOLDS };
  if (value === undefined) return defaults;
  if (!isRecord(value)) {
    warnings.push('biod.framework.reviewer.thresholds: expected an object; using defaults.');
    return defaults;
  }
  collectUnknownKeys(value, REVIEWER_THRESHOLD_KEYS, 'biod.framework.reviewer.thresholds', warnings);
  return {
    minConfidence: unitInterval(value.minConfidence, defaults.minConfidence, 'biod.framework.reviewer.thresholds.minConfidence', warnings),
    tauContradicted: unitInterval(value.tauContradicted, defaults.tauContradicted, 'biod.framework.reviewer.thresholds.tauContradicted', warnings),
    tauHolds: unitInterval(value.tauHolds, defaults.tauHolds, 'biod.framework.reviewer.thresholds.tauHolds', warnings),
    ownerMargin: unitInterval(value.ownerMargin, defaults.ownerMargin, 'biod.framework.reviewer.thresholds.ownerMargin', warnings),
    pairMargin: unitInterval(value.pairMargin, defaults.pairMargin, 'biod.framework.reviewer.thresholds.pairMargin', warnings),
    duplicateThreshold: unitInterval(value.duplicateThreshold, defaults.duplicateThreshold, 'biod.framework.reviewer.thresholds.duplicateThreshold', warnings),
    maxPairwiseIssues: integerValue(value.maxPairwiseIssues, defaults.maxPairwiseIssues, { min: 2, max: 32 }, 'biod.framework.reviewer.thresholds.maxPairwiseIssues', warnings),
    maxScoredIssues: integerValue(value.maxScoredIssues, defaults.maxScoredIssues, { min: 1, max: 256 }, 'biod.framework.reviewer.thresholds.maxScoredIssues', warnings),
    topIssues: integerValue(value.topIssues, defaults.topIssues, { min: 1, max: 50 }, 'biod.framework.reviewer.thresholds.topIssues', warnings),
  };
}

function readReviewerDecisionPoint(
  value: unknown,
  defaultMode: BiodFrameworkMode,
  warnings: string[],
): BiodFrameworkDecisionPointConfig | undefined {
  if (!isRecord(value)) {
    warnings.push('biod.framework.reviewer.decisionPoints.v1.issue-triage: expected an object; ignored.');
    return undefined;
  }
  collectUnknownKeys(value, ['mode', 'scorer', 'budget'], 'biod.framework.reviewer.decisionPoints.v1.issue-triage', warnings);
  const parsedMode = frameworkMode(
    value.mode,
    defaultMode,
    'biod.framework.reviewer.decisionPoints.v1.issue-triage.mode',
    warnings,
  );
  const mode: BiodFrameworkMode = parsedMode === 'off' || parsedMode === 'shadow' || parsedMode === 'assist'
    ? parsedMode
    : 'off';
  if (parsedMode !== mode) {
    warnings.push('biod.framework.reviewer.decisionPoints.v1.issue-triage.mode: only off/shadow/assist are supported; using "off".');
  }
  return {
    mode,
    scorer: typeof value.scorer === 'string' ? value.scorer : undefined,
    budget: frameworkBudget(value.budget, 'biod.framework.reviewer.decisionPoints.v1.issue-triage.budget', warnings),
  };
}

function frameworkMode(value: unknown, fallback: BiodFrameworkMode, field: string, warnings: string[]): BiodFrameworkMode {
  if (value === undefined) return fallback;
  if (value === 'off' || value === 'shadow' || value === 'assist' || value === 'guard' || value === 'trigger' || value === 'cascade') return value;
  warnings.push(`${field}: expected off/shadow/assist/guard/trigger/cascade; using "${fallback}".`);
  return fallback;
}

function frameworkBudget(value: unknown, field: string, warnings: string[]): BiodFrameworkBudget | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'rule'
    || value === 'short'
    || value === 'medium'
    || value === 'long'
    || value === 'max'
    || value === 'audit'
    || value === 'audit-max'
    || value === 'claim-audit'
    || value === 'claim-audit-max'
    || value === 'issue-audit'
    || value === 'issue-audit-max'
  ) {
    return value;
  }
  warnings.push(`${field}: expected rule/short/medium/long/max/audit/audit-max/claim-audit/claim-audit-max/issue-audit/issue-audit-max; ignored.`);
  return undefined;
}

function readState(value: unknown, config: BiodConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    warnings.push('biod.state: expected an object; using defaults.');
    return;
  }
  collectUnknownKeys(value, STATE_KEYS, 'biod.state', warnings);
  config.state.maxChars = integerValue(
    value.maxChars,
    config.state.maxChars,
    { min: 1, max: 20_000 },
    'biod.state.maxChars',
    warnings,
  );
}

function collectUnknownKeys(
  source: Record<string, unknown>,
  allowedKeys: readonly string[],
  prefix: string,
  warnings: string[],
): void {
  for (const key of Object.keys(source)) {
    if (!allowedKeys.includes(key)) warnings.push(`${prefix}.${key}: unknown field ignored.`);
  }
}

/**
 * `${ENV}` interpolation, except a missing variable disables that one field instead of
 * throwing. That is what lets the shipped config reference deployment-only paths.
 */
function textValue(
  value: unknown,
  field: string,
  environment: NodeJS.ProcessEnv,
  warnings: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    warnings.push(`${field}: expected a string; ignored.`);
    return undefined;
  }
  let resolved: string;
  try {
    resolved = interpolateEnvironment(value, environment, field);
  } catch (error) {
    warnings.push(`${field}: ${describeError(error)}; treated as unset.`);
    return undefined;
  }
  const trimmed = resolved.trim();
  return trimmed ? trimmed : undefined;
}

function booleanValue(value: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  warnings.push(`${field}: expected a boolean; using ${fallback}.`);
  return fallback;
}

function integerValue(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
  field: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max) {
    return value;
  }
  warnings.push(`${field}: expected an integer in [${bounds.min}, ${bounds.max}]; using ${fallback}.`);
  return fallback;
}

function unitInterval(value: unknown, fallback: number, field: string, warnings: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  warnings.push(`${field}: expected a number in [0, 1]; using ${fallback}.`);
  return fallback;
}

function modeValue(value: unknown, fallback: BiodDecisionPointMode, field: string, warnings: string[]): BiodDecisionPointMode {
  if (value === undefined) return fallback;
  if (value === 'off' || value === 'select') return value;
  warnings.push(`${field}: expected "off" or "select"; using "${fallback}".`);
  return fallback;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
