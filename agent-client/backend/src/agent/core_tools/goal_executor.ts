import type { CoreToolExecutionContext } from '../core_tools_runtime.js';
import { readScopedGoal } from '../panel_scope.js';
import {
  applyGoalMutation,
  GoalTransitionError,
  type GoalMutationRequest,
  type GoalOperation,
  type GoalState,
} from '../conversation_panels.js';

/**
 * Model-facing goal tools over the durable conversation panels.
 *
 * The goal is a state document in the transcript, not an in-memory service: every call
 * folds the log to find the current goal, compares the caller's `goal_id`/`revision`
 * pair against it (compare-and-set), and returns the complete new document for the
 * runtime to record. That is what makes a second concurrent writer fail loudly instead
 * of silently overwriting a goal it never read.
 */

/** Actions the model may take on an existing goal. `resume` is deliberately absent. */
export const GOAL_UPDATE_ACTIONS = ['edit', 'pause', 'complete', 'blocked'] as const;
export type GoalUpdateAction = (typeof GOAL_UPDATE_ACTIONS)[number];

const TOOL_GET = 'get_goal';
const TOOL_CREATE = 'create_goal';
const TOOL_UPDATE = 'update_goal';

export function isGoalTool(toolName: string): boolean {
  return toolName === TOOL_GET || toolName === TOOL_CREATE || toolName === TOOL_UPDATE;
}

/**
 * Read the current goal for a conversation.
 *
 * Returns `null` rather than throwing when the conversation has no goal: "no goal" is a
 * normal answer to `get_goal`, not an error the model should have to interpret.
 *
 * A goal is team-scoped: a role session reads the root's log and every role log merged,
 * so a goal the Web created on the root and a goal another role created are the same
 * document. `panel_scope.ts` owns that rule — see its comment for why a subagent is not
 * part of the team.
 */
export function readCurrentGoal(conversationId: string | undefined): GoalState | null {
  return readScopedGoal(conversationId);
}

export function executeGoalTool(
  toolName: string,
  args: Record<string, unknown>,
  context: CoreToolExecutionContext,
): string {
  const conversationId = context.conversationId;
  if (!conversationId) {
    return failure('A conversation is required before using goal tools.', 'GOAL_NO_CONVERSATION');
  }

  if (toolName === TOOL_GET) {
    const goal = readCurrentGoal(conversationId);
    return JSON.stringify({ ok: true, goal, message: describeGoal(goal) });
  }

  const current = readCurrentGoal(conversationId);

  try {
    if (toolName === TOOL_CREATE) {
      requireHumanAuthority(context, 'create');
      const next = applyGoalMutation(current, {
        operation: 'create',
        objective: typeof args.objective === 'string' ? args.objective : undefined,
        maxRounds: readNumber(args.max_rounds),
      });
      return success('create', next);
    }

    if (toolName === TOOL_UPDATE) {
      const action = String(args.action ?? '').trim() as GoalUpdateAction;
      assertKnownAction(action);
      // Only the human may resume a stopped goal: the model that just paused it would
      // otherwise be able to re-arm itself indefinitely.
      assertCurrentRef(current, args);
      if (action !== 'edit' && action !== 'pause' && action !== 'complete' && action !== 'blocked') {
        throw new GoalTransitionError(`unknown update action "${String(args.action)}"`, 'GOAL_INVALID_ACTION');
      }
      if (action === 'edit' || action === 'pause') {
        requireHumanAuthority(context, action);
      }
      const request: GoalMutationRequest = {
        operation: action === 'blocked' ? 'block' : action,
        ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
        ...(args.max_rounds !== undefined ? { maxRounds: readNumber(args.max_rounds) } : {}),
        ...(typeof args.blocked_reason === 'string'
          ? { blockedReason: { code: 'model-reported', message: args.blocked_reason } }
          : {}),
      };
      const next = applyGoalMutation(current, request);
      return success(request.operation, next);
    }

    return failure(`Unknown goal tool "${toolName}".`, 'GOAL_UNKNOWN_TOOL');
  } catch (error) {
    if (error instanceof GoalTransitionError) {
      return failure(error.message, error.code);
    }
    return failure(error instanceof Error ? error.message : String(error), 'GOAL_TOOL_FAILED');
  }
}

function success(operation: GoalOperation, goal: GoalState | null): string {
  return JSON.stringify({
    ok: true,
    operation,
    goal,
    message: operation === 'clear' ? 'Goal cleared.' : describeGoal(goal),
    uiEvent: { type: 'goal_change', operation, goal },
  });
}

function failure(message: string, code: string): string {
  return JSON.stringify({ ok: false, error: message, code });
}

function describeGoal(goal: GoalState | null): string {
  if (!goal) return 'No goal is currently set for this conversation.';
  const rounds = `${goal.roundsStarted}/${goal.maxRounds}`;
  const blocked = goal.phase === 'blocked' && goal.blockedReason
    ? ` Blocked: ${goal.blockedReason.message}`
    : '';
  return `Goal ${goal.id} is ${goal.phase} (revision ${goal.revision}, rounds ${rounds}). Objective: ${goal.objective}.${blocked}`;
}

/**
 * Reject a mutation aimed at a goal the model did not just read.
 *
 * The pair — not the id alone — is the guard: an id survives edits, so accepting an id
 * without the revision would let a stale caller overwrite an edit it never saw.
 */
function assertCurrentRef(current: GoalState | null, args: Record<string, unknown>): void {
  if (!current) {
    throw new GoalTransitionError('no goal is currently set', 'GOAL_NOT_FOUND');
  }
  const goalId = String(args.goal_id ?? '').trim();
  const revision = Number(args.revision);
  if (!goalId || !Number.isSafeInteger(revision) || revision < 1) {
    throw new GoalTransitionError('goal_id and revision are required; read them with get_goal first', 'GOAL_INVALID_REF');
  }
  if (goalId !== current.id) {
    throw new GoalTransitionError(`no goal with id "${goalId}" is current`, 'GOAL_NOT_FOUND');
  }
  if (revision !== current.revision) {
    throw new GoalTransitionError(
      `goal revision is ${current.revision}, not ${revision}; read the goal again before updating`,
      'GOAL_STALE_REVISION',
    );
  }
}

function assertKnownAction(action: string): void {
  if (!GOAL_UPDATE_ACTIONS.includes(action as GoalUpdateAction)) {
    throw new GoalTransitionError(
      `update_goal action must be one of ${GOAL_UPDATE_ACTIONS.join(', ')}`,
      'GOAL_INVALID_ACTION',
    );
  }
}

/**
 * Refuse goal lifecycle changes coming from a delegated run.
 *
 * Only the top-level agent may start, stop or re-plan a goal; a subagent editing the
 * objective would let a helper redefine the work it was asked to do. `complete` and
 * `blocked` are allowed from any depth because they report an outcome the run observed.
 */
function requireHumanAuthority(context: CoreToolExecutionContext, action: string): void {
  const depth = executionDepth(context);
  if (depth > 0) {
    throw new GoalTransitionError(
      `only the top-level agent may ${action} a goal; this run is a delegated subagent`,
      'GOAL_REQUIRES_TOP_LEVEL_AGENT',
    );
  }
}

/**
 * Delegation depth of the run executing this tool.
 *
 * Declared locally rather than required on `CoreToolExecutionContext`: the field is set by
 * delegated runs, and a context that does not carry it is a top-level run. Reading it this
 * way keeps this module independent of whether the shared context type declares it yet.
 */
function executionDepth(context: CoreToolExecutionContext): number {
  const depth = (context as CoreToolExecutionContext & { delegationDepth?: number }).delegationDepth;
  return typeof depth === 'number' && depth > 0 ? depth : 0;
}

function readNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
