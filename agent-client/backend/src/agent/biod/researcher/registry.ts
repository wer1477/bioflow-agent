/** Registry constants shared by config validation and BiodService. */
export const PLAN_AUDIT_DECISION_POINT = 'r1.plan-audit' as const;
export const PLAN_AUDIT_MODES = ['off', 'shadow', 'assist'] as const;
export const PLAN_AUDIT_DEFAULT_SCORER = 'heuristic';
export const PLAN_AUDIT_DEFAULT_BUDGET = 'audit';
