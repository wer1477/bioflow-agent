import type { AgentEvent } from './types.js';
import { readGoalSnapshot, type GoalOperation } from './conversation_panels.js';

type WorkspaceArtifactEvent = Extract<AgentEvent, { type: 'workspace_artifact' }>;
type PlanningPanelEvent = Extract<AgentEvent, { type: 'planning_panel' }>;
type GoalChangeEvent = Extract<AgentEvent, { type: 'goal_change' }>;

const GOAL_OPERATIONS: readonly GoalOperation[] = ['create', 'edit', 'pause', 'resume', 'complete', 'block', 'clear'];

/**
 * Extract runtime-only events embedded in a successful tool result.
 *
 * Tool implementations keep returning a JSON string for the model contract,
 * while both sequential and parallel runtime paths share this one parser for
 * workspace and planning side effects.
 */
export function extractToolResultEvents(result: string): AgentEvent[] {
  const payload = parseSuccessfulToolResult(result);
  if (!payload) return [];

  const events: AgentEvent[] = [];
  const artifact = parseWorkspaceArtifact(payload);
  if (artifact) events.push({ type: 'workspace_artifact', artifact });
  const planning = parsePlanningPanelEvent(payload);
  if (planning) events.push(planning);
  const goal = parseGoalChangeEvent(payload);
  if (goal) events.push(goal);
  return events;
}

function parseSuccessfulToolResult(result: string): Record<string, unknown> | null {
  try {
    const payload: unknown = JSON.parse(result);
    if (!isRecord(payload) || payload.ok !== true) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseWorkspaceArtifact(payload: Record<string, unknown>): WorkspaceArtifactEvent['artifact'] | null {
  const file = payload.file;
  if (!isRecord(file) || !file.id || !file.path) return null;
  return {
    id: String(file.id),
    title: String(file.title || file.workspacePath || file.path),
    path: String(file.workspacePath || file.path),
    type: String(file.type || 'file'),
  };
}

function parsePlanningPanelEvent(payload: Record<string, unknown>): PlanningPanelEvent | null {
  const event = payload.uiEvent;
  if (!isRecord(event)) return null;
  const panel = String(event.panel);
  const status = String(event.status);
  if (event.type !== 'planning_panel' || !['clarify', 'plan', 'todo'].includes(panel) || !['waiting', 'active', 'complete'].includes(status)) return null;
  return {
    type: 'planning_panel',
    panel: panel as PlanningPanelEvent['panel'],
    status: status as PlanningPanelEvent['status'],
    title: String(event.title || '任务规划'),
    questions: Array.isArray(event.questions) ? event.questions as PlanningPanelEvent['questions'] : undefined,
    markdown: typeof event.markdown === 'string' ? event.markdown : undefined,
    filePath: typeof event.filePath === 'string' ? event.filePath : undefined,
    todos: Array.isArray(event.todos) ? event.todos as PlanningPanelEvent['todos'] : undefined,
    note: typeof event.note === 'string' ? event.note : undefined,
  };
}

/**
 * Read the goal state document a goal tool reported.
 *
 * The tool result is the model's contract, so the event is derived from the same JSON:
 * the runtime records the state the model just wrote, not a re-derivation of it. A clear
 * arrives as `goal: null`, which is a legitimate state document (the tombstone).
 */
function parseGoalChangeEvent(payload: Record<string, unknown>): GoalChangeEvent | null {
  const event = payload.uiEvent;
  if (!isRecord(event) || event.type !== 'goal_change') return null;
  const operation = String(event.operation || '').trim() as GoalOperation;
  if (!GOAL_OPERATIONS.includes(operation)) return null;
  return {
    type: 'goal_change',
    operation,
    goal: readGoalSnapshot(event.goal),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * The files a tool reported producing.
 *
 * Two shapes carry them today: `file: {path}` for tools that hand back a single
 * artifact, and `artifacts: [{path}]` for `execute_python`, whose kernel promotes
 * generated figures into workspace artifacts. Both are read from the result the tool
 * already returned, so nothing new is asked of the tool layer — and a tool that
 * produces files without reporting them contributes nothing rather than a guess.
 *
 * Deliberately not gated on `ok`: a failed cell can still have written figures.
 */
export function producedFilesOf(result: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(result);
  } catch {
    return [];
  }
  if (!isRecord(payload)) return [];

  const paths = new Set<string>();
  const file = payload.file;
  if (isRecord(file)) {
    const value = typeof file.workspacePath === 'string' ? file.workspacePath : file.path;
    if (typeof value === 'string' && value) paths.add(value);
  }
  if (Array.isArray(payload.artifacts)) {
    for (const artifact of payload.artifacts) {
      if (!isRecord(artifact)) continue;
      const value = artifact.path;
      if (typeof value === 'string' && value) paths.add(value);
    }
  }
  return [...paths];
}
