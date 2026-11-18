/**
 * Preset selection for the create-provider dialog.
 *
 * Switching presets replaces the provider identity — endpoint, name, thinking format, key and
 * model rows all belong to the provider — but it must not *lose* work: comparing two endpoints and
 * clicking back is normal, and discarding a pasted key every time makes that painful. The dialog
 * therefore remembers one draft per preset id and restores it on the way back. Nothing here talks
 * to the network; `loadModels` only says whether the caller still has to fetch the catalog models.
 */

/** A preset's untouched draft: identity from the catalog, no credential, no model rows yet. */
export function draftForPreset(preset) {
  return {
    id: '',
    presetId: preset.id,
    name: preset.name || '',
    baseUrl: preset.api || '',
    apiKey: '',
    thinkingFormat: preset.suggestedThinkingFormat || 'openai-effort',
    protocol: preset.protocol || 'openai-completions',
    defaultModelId: '',
    models: [],
  };
}

/**
 * Selects `preset` for the editor.
 *
 * Returns `{ draft, drafts, loadModels }`:
 * - re-selecting the active preset keeps the draft (manual edits included) and fetches nothing;
 * - a remembered draft for this preset — a key typed earlier included — is restored as-is;
 * - otherwise the current draft is filed under its own preset id, a fresh preset draft replaces it,
 *   and `loadModels` says whether the caller should fetch the catalog's model rows.
 */
export function selectPresetDraft(editor, preset) {
  const current = editor?.draft;
  const drafts = { ...(editor?.drafts || {}) };
  if (!current) return { draft: null, drafts, loadModels: false };
  if (current.presetId === preset.id) return { draft: current, drafts, loadModels: false };

  if (current.presetId) drafts[current.presetId] = current;
  const remembered = drafts[preset.id];
  if (remembered) return { draft: remembered, drafts, loadModels: false };

  return { draft: draftForPreset(preset), drafts, loadModels: Boolean(preset.modelCount) };
}
