/** Shared S2 constants used by config validation, BiodService, and the dispatcher. */
export const HYPOTHESIS_SCREEN_TOOL_ACTION = 'hypothesis-screen' as const;
/** Synthetic decision-point id for the report/ledger. The framework still records the
 * real s2.premise / s2.rerank / s2.policy decisions separately. */
export const HYPOTHESIS_SCREEN_DECISION_POINT = 's2.hypothesis-screen' as const;
export const HYPOTHESIS_SCREEN_DEFAULT_PATH = 'research/hypotheses.yaml';
export const HYPOTHESIS_SCREEN_REPORT_ROOT = 'research';
export const HYPOTHESIS_SCREEN_MODEL_VERSION = 'heuristic-v1';
export const HYPOTHESIS_SCREEN_POLICY_VERSION = 's2.policy-v1';
export const HYPOTHESIS_SCREEN_RENDERER_VERSION = 'searcher-screen-v1';
