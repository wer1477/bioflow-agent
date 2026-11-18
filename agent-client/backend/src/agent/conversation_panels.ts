import crypto from 'node:crypto';
import type { TranscriptRecord } from './transcript_reader.js';

/**
 * Durable conversation panels: the to-do list and the current goal, folded from the
 * transcript log.
 *
 * Both are *state documents*, not event deltas: every `planning_panel` with
 * `panel: 'todo'` and every `goal_change` carries the complete post-change value.
 * That is what keeps the fold last-write-wins (no sequence arithmetic, no partial
 * reconstruction), and it is why a reader that arrives late — a reload, a second
 * browser, a resumed session — sees exactly the state the writer intended.
 *
 * The fold is pure and storage-free so both the HTTP layer and the tests can run it
 * over a record array without touching disk.
 */

/** Lifecycle of one to-do item. `in_progress` is what "which task is running" means. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

/** Durable goal lifecycle. `complete` is a phase; `blocked` carries a reason. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

export interface GoalBlockedReason {
  code: string;
  message: string;
}

/**
 * The complete durable goal document written by every non-clear mutation.
 *
 * `autoContinue` ("armed") is part of the document because this runtime has no
 * process-local goal registry: the goal has to carry its own permission to start
 * another round, or a resumed conversation would silently resume burning tokens.
 */
export interface GoalSnapshot {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  blockedReason?: GoalBlockedReason;
  maxRounds: number;
  autoContinue: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Projected goal: the durable document plus the round count derived from the log. */
export interface GoalState extends GoalSnapshot {
  roundsStarted: number;
}

export type GoalOperation = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear';

/** State-changing verbs the model tools and the HTTP endpoints share. */
export interface GoalMutationRequest {
  operation: GoalOperation;
  objective?: string;
  maxRounds?: number;
  blockedReason?: GoalBlockedReason;
}

/** Rejection with a machine-readable code, mirroring the tool error vocabulary. */
export class PanelValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PanelValidationError';
  }
}

/** A goal mutation that the transition table refused. */
export class GoalTransitionError extends PanelValidationError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'GoalTransitionError';
  }
}

export interface ConversationPanels {
  /** Sequence of the last transcript record this fold saw; `-1` for an empty log. */
  asOfSequence: number;
  goal: GoalState | null;
  /** `null` means "no list has ever been written, or the last write cleared it". */
  todos: TodoItem[] | null;
}

export const DEFAULT_GOAL_MAX_ROUNDS = 5;
export const MAX_GOAL_ROUNDS_LIMIT = 50;

const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];
const GOAL_PHASES: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete'];

/**
 * Normalize a submitted to-do list into the canonical three-state shape.
 *
 * Accepts the legacy `done: boolean` spelling as well: transcripts recorded before the
 * status migration still carry it, and a reader must be able to render them. Every
 * rejection is explicit — silently dropping an item would make the durable list differ
 * from what the model believes it wrote.
 */
export function normalizeTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const record = isPlainRecord(entry) ? entry : {};
    const text = String(record.text ?? record.content ?? '').trim();
    if (!text) throw new PanelValidationError('todo item text must be a non-empty string', 'TODO_INVALID_TEXT');
    if (seen.has(text)) throw new PanelValidationError(`duplicate todo text ${JSON.stringify(text)}`, 'TODO_DUPLICATE_TEXT');
    seen.add(text);
    const rawStatus = String(record.status ?? '').trim();
    const status: TodoStatus = rawStatus
      ? (rawStatus as TodoStatus)
      : record.done === true
        ? 'completed'
        : 'pending';
    if (!TODO_STATUSES.includes(status)) {
      throw new PanelValidationError(`todo status must be one of ${TODO_STATUSES.join(', ')}`, 'TODO_INVALID_STATUS');
    }
    items.push({
      id: normalizeTodoId(record.id, index, text),
      text,
      status,
    });
  }
  return items;
}

function normalizeTodoId(value: unknown, index: number, text: string): string {
  const raw = String(value ?? '').trim();
  const candidate = raw || `todo${index + 1}`;
  const safe = candidate.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return safe || `todo-${hashText(text).slice(0, 8)}`;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Read a goal snapshot out of an untrusted payload, keeping only known fields. */
export function readGoalSnapshot(value: unknown): GoalSnapshot | null {
  if (!isPlainRecord(value)) return null;
  const id = String(value.id ?? '').trim();
  const objective = String(value.objective ?? '').trim();
  const phase = String(value.phase ?? '').trim() as GoalPhase;
  const revision = Number(value.revision);
  if (!id || !objective || !GOAL_PHASES.includes(phase)) return null;
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const maxRounds = normalizeMaxRounds(value.maxRounds, { fallback: DEFAULT_GOAL_MAX_ROUNDS, strict: false });
  const blockedReason = readBlockedReason(value.blockedReason);
  return {
    id,
    revision,
    objective,
    phase,
    ...(phase === 'blocked' && blockedReason ? { blockedReason } : {}),
    maxRounds,
    autoContinue: value.autoContinue === true,
    createdAt: readTimestamp(value.createdAt),
    updatedAt: readTimestamp(value.updatedAt),
  };
}

function readBlockedReason(value: unknown): GoalBlockedReason | null {
  if (!isPlainRecord(value)) return null;
  const code = String(value.code ?? '').trim();
  const message = String(value.message ?? '').trim();
  if (!code || !message) return null;
  return { code, message };
}

function readTimestamp(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (raw && Number.isFinite(Date.parse(raw))) return raw;
  return new Date(0).toISOString();
}

function normalizeMaxRounds(
  value: unknown,
  { fallback, strict }: { fallback: number; strict: boolean },
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const rounds = Number(value);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > MAX_GOAL_ROUNDS_LIMIT) {
    if (!strict) return fallback;
    throw new GoalTransitionError(
      `maxRounds must be a positive integer up to ${MAX_GOAL_ROUNDS_LIMIT}`,
      'GOAL_INVALID_MAX_ROUNDS',
    );
  }
  return rounds;
}

/**
 * Fold the transcript log into the current panels.
 *
 * Only two record shapes matter here: an `engine_event` whose payload is a
 * `planning_panel` (panel=todo) or a `goal_change` / `goal_round`. Records of any other
 * type are ignored, which is what lets the log grow new vocabularies without touching
 * this module.
 */
export function foldConversationPanels(records: readonly TranscriptRecord[]): ConversationPanels {
  let goal: GoalState | null = null;
  let todos: TodoItem[] | null = null;
  let asOfSequence = -1;

  for (const record of records) {
    asOfSequence = Math.max(asOfSequence, record.sequence);
    if (record.type !== 'engine_event') continue;
    const event = readEngineEvent(record.data);
    if (!event) continue;

    if (event.type === 'planning_panel') {
      const panel = String(event.panel ?? '');
      if (panel !== 'todo') continue;
      if (String(event.status ?? '') === 'complete') {
        todos = null;
        continue;
      }
      try {
        todos = normalizeTodoItems(event.todos);
      } catch {
        // A recorded list that cannot be normalized (hand-edited log, newer writer)
        // must not take the whole panel down: keep the last good one instead.
      }
      continue;
    }

    if (event.type === 'goal_change') {
      const next = readGoalSnapshot(event.goal);
      if (next === null) {
        goal = null;
        continue;
      }
      goal = { ...next, roundsStarted: carryGoalRounds(goal, next) };
      continue;
    }

    if (event.type === 'goal_round') {
      if (!goal) continue;
      if (String(event.goalId ?? '') !== goal.id) continue;
      const round = Number(event.round);
      if (!Number.isSafeInteger(round) || round < 1) continue;
      goal = { ...goal, roundsStarted: Math.max(goal.roundsStarted, round) };
    }
  }

  return { asOfSequence, goal, todos };
}

/**
 * Round count to carry across a goal edit or phase change.
 *
 * Rounds belong to the goal identity, not to a revision: editing the objective or
 * pausing and resuming must not reset how much of the budget was already spent.
 */
function carryGoalRounds(previous: GoalState | null, next: GoalSnapshot): number {
  return previous !== null && previous.id === next.id ? previous.roundsStarted : 0;
}

function readEngineEvent(data: Record<string, unknown>): Record<string, unknown> | null {
  const event = data?.event;
  return isPlainRecord(event) ? event : null;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Apply one goal mutation to the current state and return the next document.
 *
 * Pure: the caller decides how to persist it. Every rule that a caller could otherwise
 * get subtly wrong lives here — allowed source phases, revision bumps, timestamp
 * monotonicity, and the `autoContinue` flag that each phase forces.
 */
export function applyGoalMutation(
  current: GoalState | null,
  request: GoalMutationRequest,
  now: string = new Date().toISOString(),
): GoalState | null {
  const operation = request.operation;

  if (operation === 'create') {
    if (current !== null && current.phase !== 'complete') {
      throw new GoalTransitionError(
        'a goal already exists for this conversation; clear it before creating another',
        'GOAL_ALREADY_EXISTS',
      );
    }
    const objective = normalizeObjective(request.objective);
    return {
      id: `goal-${crypto.randomUUID()}`,
      revision: 1,
      objective,
      phase: 'active',
      maxRounds: normalizeMaxRounds(request.maxRounds, { fallback: DEFAULT_GOAL_MAX_ROUNDS, strict: true }),
      autoContinue: true,
      createdAt: now,
      updatedAt: now,
      roundsStarted: 0,
    };
  }

  if (operation === 'clear') {
    return null;
  }

  if (current === null) {
    throw new GoalTransitionError('no goal is currently set', 'GOAL_NOT_FOUND');
  }

  const base = {
    id: current.id,
    revision: current.revision + 1,
    createdAt: current.createdAt,
    updatedAt: nextTimestamp(current.updatedAt, now),
    roundsStarted: current.roundsStarted,
  };

  switch (operation) {
    case 'edit': {
      const objective = request.objective === undefined ? current.objective : normalizeObjective(request.objective);
      const maxRounds = request.maxRounds === undefined
        ? current.maxRounds
        : normalizeMaxRounds(request.maxRounds, { fallback: current.maxRounds, strict: true });
      return {
        ...base,
        objective,
        maxRounds,
        phase: current.phase,
        ...(current.blockedReason ? { blockedReason: current.blockedReason } : {}),
        autoContinue: current.autoContinue,
      };
    }
    case 'pause': {
      if (current.phase !== 'active') {
        throw new GoalTransitionError(`cannot pause a goal in phase "${current.phase}"`, 'GOAL_INVALID_TRANSITION');
      }
      return { ...base, objective: current.objective, maxRounds: current.maxRounds, phase: 'paused', autoContinue: false };
    }
    case 'resume': {
      if (current.phase === 'complete') {
        throw new GoalTransitionError('a complete goal cannot be resumed; create a new goal instead', 'GOAL_INVALID_TRANSITION');
      }
      if (current.phase === 'active' && current.autoContinue) {
        throw new GoalTransitionError('the goal is already active and armed', 'GOAL_INVALID_TRANSITION');
      }
      if (current.roundsStarted >= current.maxRounds) {
        throw new GoalTransitionError(
          `goal exhausted its ${current.maxRounds} rounds; raise max_rounds before resuming`,
          'GOAL_ROUNDS_EXHAUSTED',
        );
      }
      return { ...base, objective: current.objective, maxRounds: current.maxRounds, phase: 'active', autoContinue: true };
    }
    case 'complete': {
      if (current.phase === 'complete') {
        throw new GoalTransitionError('the goal is already complete', 'GOAL_INVALID_TRANSITION');
      }
      return { ...base, objective: current.objective, maxRounds: current.maxRounds, phase: 'complete', autoContinue: false };
    }
    case 'block': {
      if (current.phase !== 'active') {
        throw new GoalTransitionError(`cannot block a goal in phase "${current.phase}"`, 'GOAL_INVALID_TRANSITION');
      }
      const reason = request.blockedReason;
      if (!reason || !reason.code.trim() || !reason.message.trim()) {
        throw new GoalTransitionError('blocking a goal requires a code and a message', 'GOAL_INVALID_BLOCK_REASON');
      }
      return {
        ...base,
        objective: current.objective,
        maxRounds: current.maxRounds,
        phase: 'blocked',
        blockedReason: { code: reason.code.trim(), message: reason.message.trim() },
        autoContinue: false,
      };
    }
    default: {
      throw new GoalTransitionError(`unknown goal operation "${String(operation)}"`, 'GOAL_INVALID_TRANSITION');
    }
  }
}

function normalizeObjective(value: string | undefined): string {
  const objective = String(value ?? '').trim();
  if (!objective) throw new GoalTransitionError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE');
  return objective;
}

/** Keep `updatedAt` monotonic even if the wall clock steps backwards. */
function nextTimestamp(previous: string, now: string): string {
  const previousMs = Date.parse(previous);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(previousMs) || !Number.isFinite(nowMs)) return now;
  return nowMs >= previousMs ? now : previous;
}

/**
 * Whether the round loop may start another round for this goal.
 *
 * Deliberately a separate function: the HTTP loop, the tests and the UI all need to
 * answer this question identically, and the answer is the safety boundary of the whole
 * autonomous path.
 */
export function canStartGoalRound(goal: GoalState | null): goal is GoalState {
  if (!goal) return false;
  return goal.phase === 'active' && goal.autoContinue && goal.roundsStarted < goal.maxRounds;
}

/**
 * The instruction a continuation round receives.
 *
 * The objective is JSON-encoded so a multi-line objective cannot forge the surrounding
 * envelope, and the round counter is stated in the prompt because the model otherwise
 * has no way to know how much of its budget is gone.
 */
export function renderGoalRoundPrompt(goal: GoalState, round: number): string {
  return [
    '<goal_round>',
    `Objective: ${JSON.stringify(goal.objective)}`,
    `Round: ${round}/${goal.maxRounds}`,
    '',
    'Continue working toward the objective in this same conversation. Treat the workspace,',
    'tool results and conversation state as authoritative; inspect them instead of assuming',
    'earlier narration is still current. Make concrete progress and verify the result.',
    'Before claiming completion, gather evidence that the whole objective is achieved, read',
    'the current goal with get_goal, and mark it complete with update_goal. If work remains,',
    'leave the goal active for the next round. Report a blocker only after the same concrete',
    'condition has persisted across rounds.',
    '</goal_round>',
  ].join('\n');
}
