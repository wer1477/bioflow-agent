import {
  EXECUTE_PYTHON_TOOL_NAME,
  FILE_CORE_TOOL_ID,
  GOAL_CORE_TOOL_ID,
  KNOWLEDGEBASE_TOOL_NAME,
  PLANNING_TOOL_NAME,
  SEARCH_CORE_TOOL_ID,
  SHELL_CORE_TOOL_ID,
  SUBAGENT_TOOL_NAME,
  TEAM_MESSAGE_CORE_TOOL_ID,
  TOOLLIBRARY_CORE_TOOL_ID,
  TOOLLIBRARY_TOOL_NAME,
  TOOLLOAD_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../../core_tools/ids.js';
import type { CurrentToolKind, PlanStep, PlanToolCandidate } from './contracts.js';
import { NO_TOOL_ID, type PlanAuditPrefilter } from './contracts.js';

/**
 * Builds the scorable row set for one plan step.
 *
 * The tool set is the role's live binding snapshot, never a catalog the role cannot load.
 * `NO_TOOL` is always present; an unknown/current-core tool is described by its kind rather
 * than being silently added to the library candidates.
 */

export interface StepCandidateSet {
  candidates: PlanToolCandidate[];
  currentToolKind: CurrentToolKind;
  currentToolId?: string;
  /** Library tools removed by the lexical prefilter; kept for the ledger, not policy. */
  prefilteredOut: string[];
}

const CORE_TOOL_IDS = new Set([
  SHELL_CORE_TOOL_ID,
  EXECUTE_PYTHON_TOOL_NAME,
  FILE_CORE_TOOL_ID,
  SEARCH_CORE_TOOL_ID,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  PLANNING_TOOL_NAME,
  GOAL_CORE_TOOL_ID,
  SUBAGENT_TOOL_NAME,
  TEAM_MESSAGE_CORE_TOOL_ID,
  KNOWLEDGEBASE_TOOL_NAME,
  TOOLLIBRARY_CORE_TOOL_ID,
  TOOLLIBRARY_TOOL_NAME,
  TOOLLOAD_TOOL_NAME,
]);

export interface RoleToolEntry {
  id: string;
  name: string;
  kind: 'skill' | 'mcp';
  description: string;
  domain?: string;
}

export function toPlanToolCandidate(entry: RoleToolEntry): PlanToolCandidate {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    ...(entry.domain ? { domain: entry.domain } : {}),
    description: entry.description,
    isCurrent: false,
  };
}

export function buildStepCandidates(
  step: PlanStep,
  tools: PlanToolCandidate[],
  prefilter: PlanAuditPrefilter,
): StepCandidateSet {
  const currentId = step.currentToolId;
  const currentInLibrary = Boolean(currentId && tools.some((tool) => tool.id === currentId));
  const currentToolKind: CurrentToolKind = !currentId
    ? 'none'
    : currentInLibrary
      ? 'library'
      : CORE_TOOL_IDS.has(currentId)
        ? 'core'
        : 'unknown';

  const all = tools.map((tool) => ({ ...tool, isCurrent: tool.id === currentId }));
  const ranked = prefilter.mode === 'lexical'
    ? lexicalPrefilter(step, all, prefilter.maxCandidates)
    : { kept: all, removed: [] as string[] };

  const candidates = ranked.kept.map((tool) => ({ ...tool }));
  candidates.push(noToolCandidate());
  return {
    candidates: seededShuffle(candidates, `${step.id}:${step.goal}:${candidates.length}`),
    currentToolKind,
    ...(currentId ? { currentToolId: currentId } : {}),
    prefilteredOut: ranked.removed,
  };
}

function lexicalPrefilter(
  step: PlanStep,
  tools: PlanToolCandidate[],
  maxCandidates: number,
): { kept: PlanToolCandidate[]; removed: string[] } {
  const limit = Math.max(1, Math.floor(maxCandidates));
  if (tools.length <= limit) return { kept: tools, removed: [] };
  const stepTokens = tokensFor([step.goal, ...step.inputs, ...step.outputs, ...step.constraints].join(' '));
  const scored = tools.map((tool) => ({
    tool,
    score: lexicalScore(stepTokens, `${tool.name} ${tool.description}`),
    current: tool.isCurrent,
  }));
  scored.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return right.score - left.score || left.tool.id.localeCompare(right.tool.id);
  });
  const kept = scored.slice(0, limit).map((entry) => entry.tool);
  const keptIds = new Set(kept.map((tool) => tool.id));
  const removed = tools.filter((tool) => !keptIds.has(tool.id)).map((tool) => tool.id);
  return { kept, removed };
}

function noToolCandidate(): PlanToolCandidate {
  return {
    id: NO_TOOL_ID,
    name: NO_TOOL_ID,
    kind: 'pseudo',
    description: 'Do not recommend a tool; keep the current approach or manual work.',
    isCurrent: false,
  };
}

function lexicalScore(stepTokens: Set<string>, toolText: string): number {
  if (stepTokens.size === 0) return 0;
  const toolTokens = tokensFor(toolText);
  if (toolTokens.size === 0) return 0;
  let matches = 0;
  for (const token of stepTokens) {
    if (toolTokens.has(token)) matches += 1;
  }
  return matches / stepTokens.size;
}

function tokensFor(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9_./+-]+|[\u4e00-\u9fff]/g) ?? [];
  return new Set(matches.filter((token) => token.length > 0));
}

function seededShuffle<T>(items: T[], seedText: string): T[] {
  const copy = [...items];
  let seed = hashString(seedText) || 1;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const swap = seed % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function hashString(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
