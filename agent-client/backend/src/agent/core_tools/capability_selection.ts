import { KNOWLEDGEBASE_TOOL_NAME, TOOLLIBRARY_CORE_TOOL_ID } from './ids.js';

/**
 * Who picks a capability for a role.
 *
 * `biod` is the runtime decision sidecar. `llm` means the model browses the catalog and
 * chooses with `toolload` / `read` itself. A role opts into `biod` by binding the CoreTool;
 * the capability families stay resident either way, so an unconfigured role can still reach
 * its own (possibly empty) library instead of losing the tools entirely.
 */
export type CapabilitySelectionMode = 'biod' | 'llm';

/** The capability families that are never removed from a role's context. */
export const CAPABILITY_CORE_TOOL_IDS = [TOOLLIBRARY_CORE_TOOL_ID, KNOWLEDGEBASE_TOOL_NAME] as const;
export type CapabilityCoreToolId = (typeof CAPABILITY_CORE_TOOL_IDS)[number];

export function isCapabilityCoreToolId(id: string): id is CapabilityCoreToolId {
  return (CAPABILITY_CORE_TOOL_IDS as readonly string[]).includes(id);
}

/**
 * The CoreTool ids whose schemas a run installs.
 *
 * The capability families are appended to every explicit list: the tool library and the
 * knowledge base are part of the role's context whether or not the role delegates selection
 * to biod. `undefined` keeps the "no profile" sentinel — callers that do not go through an
 * Agent profile still install every registered CoreTool.
 */
export function residentCoreToolIds(configured: readonly string[] | undefined): string[] | undefined {
  if (configured === undefined) return undefined;
  const ids = [...new Set(configured.map(String))];
  for (const id of CAPABILITY_CORE_TOOL_IDS) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** `biod` when the role bound the CoreTool; otherwise the model selects. */
export function capabilitySelectionMode(
  configured: readonly string[] | undefined,
  id: CapabilityCoreToolId,
): CapabilitySelectionMode {
  if (configured === undefined) return 'biod';
  return configured.includes(id) ? 'biod' : 'llm';
}

export function capabilitySelectionModes(
  configured: readonly string[] | undefined,
): Record<CapabilityCoreToolId, CapabilitySelectionMode> {
  return {
    toollibrary: capabilitySelectionMode(configured, TOOLLIBRARY_CORE_TOOL_ID),
    knowledgebase: capabilitySelectionMode(configured, KNOWLEDGEBASE_TOOL_NAME),
  };
}
