import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { buildAllCoreTools, buildCoreToolsForIds } from './core_tools_runtime.js';
import { residentCoreToolIds } from './core_tools/capability_selection.js';

/**
 * The tool schemas that are resident for every request of a run.
 *
 * One function for both consumers on purpose: the runtime installs exactly this set
 * before its first turn, and the context assembly prices exactly this set into the
 * pre-run budget. When the two lists were written separately, assembly priced zero
 * tool tokens and the watermark it reported was consistently ~3–4k tokens low.
 *
 * MCP tools are not here: they enter the request only after `toolload`, so they are
 * counted by the runtime's per-turn budget (`toolsScope: 'request'`) rather than here
 * (`toolsScope: 'resident'`).
 *
 * `history_lookup` was part of this set until it was temporarily removed: the tool let
 * the model reopen content the assembly had already dropped, which hid the fact that
 * the context never accumulates across runs. Re-add it here (and re-wire the
 * dispatcher) once cross-run retention is fixed.
 *
 * The set is the agent's explicit `coreToolIds` plus the two capability families: the tool
 * library and the knowledge base are never removed from a role's context. Binding them only
 * switches selection from the model to biod (see `core_tools/capability_selection.ts`). An
 * agent configured with `[]` therefore still installs those two; `undefined` keeps the
 * pre-configuration behavior for direct runtime callers (internal callers and tests).
 */
export function buildResidentTools(coreToolIds?: readonly string[]): ChatCompletionTool[] {
  const ids = residentCoreToolIds(coreToolIds);
  if (ids === undefined) return buildAllCoreTools();
  return buildCoreToolsForIds(ids);
}
