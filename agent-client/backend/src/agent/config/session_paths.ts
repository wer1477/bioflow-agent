import path from 'node:path';
import { sessionsRoot } from '../../paths.js';
import { assertPathSegment } from './path_segments.js';
import { projectKey } from './project_key.js';

/**
 * Paths of the central session store:
 *   `WORKSPACE_ROOT/.sessions/<projectKey>/<sessionId>/`
 *
 * Session state never lives inside a project directory, so a project folder can
 * be created empty, moved, shared or trashed without carrying engine state.
 */
export function sessionDirectory(projectKeyValue: string, sessionId: string): string {
  return path.join(
    sessionsRoot(),
    assertPathSegment(projectKeyValue, 'project key'),
    assertPathSegment(sessionId, 'conversation id'),
  );
}

export function sessionFilePath(projectKeyValue: string, sessionId: string): string {
  return path.join(sessionDirectory(projectKeyValue, sessionId), 'session.json');
}

export function historyFilePath(projectKeyValue: string, sessionId: string): string {
  return path.join(sessionDirectory(projectKeyValue, sessionId), 'history.jsonl');
}

export function legacyHistoryFilePath(projectKeyValue: string, sessionId: string): string {
  return path.join(sessionDirectory(projectKeyValue, sessionId), 'history.json');
}

export function artifactsFilePath(projectKeyValue: string, sessionId: string): string {
  return path.join(sessionDirectory(projectKeyValue, sessionId), 'artifacts.json');
}

export function transcriptDirectory(projectKeyValue: string, sessionId: string): string {
  return path.join(sessionDirectory(projectKeyValue, sessionId), 'transcript');
}

/**
 * Team state of a root conversation: routing mode, active role and the handoff cards.
 * Lives beside the root's own session state, so a team is one directory tree.
 */
export function teamStateFilePath(projectKeyValue: string, sessionId: string): string {
  return path.join(sessionDirectory(projectKeyValue, sessionId), 'team.json');
}

/**
 * Per-role model overrides of a team root: "in this session, this role answers with that
 * provider/model/level". A separate file from `team.json` on purpose — routing state and
 * model choice have different lifecycles, and a new file needs no schema migration.
 */
export function llmOverridesFilePath(projectKeyValue: string, sessionId: string): string {
  return path.join(sessionDirectory(projectKeyValue, sessionId), 'llm-overrides.json');
}

/** Session-local audit trail: engine bookkeeping, deliberately outside the project. */
export function observationsDirectory(projectKeyValue: string, sessionId: string): string {
  return path.join(sessionDirectory(projectKeyValue, sessionId), 'observations');
}

/**
 * A project key is the escaped *directory name*, not the absolute path: moving
 * the whole workspace root must not orphan every session.
 */
export function projectKeyForPath(projectPath: string): string {
  return projectKey(path.basename(path.resolve(projectPath)));
}
