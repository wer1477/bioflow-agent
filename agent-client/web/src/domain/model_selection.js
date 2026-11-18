/**
 * Pure helpers behind the composer's model picker.
 *
 * The picker renders two things the backend already decided — which role answers, and which
 * provider/model/level that role resolves to — plus a catalog to browse. Everything here is
 * a pure function of those inputs so it can be tested without a DOM, the same way
 * `llm_options.js` backs the settings page.
 */

/**
 * Normalize the two catalog sources into one shape.
 *
 * Administrators and the development instance read the global provider list from
 * `GET /api/settings`; a signed-in regular user gets "system presets + my own providers"
 * from `GET /api/me/llm`. They expose the same model fields, so the menu does not need to
 * know which one produced it.
 */
export function buildModelCatalog({ settings = null, userLlm = null } = {}) {
  const source = userLlm?.providers || userLlm?.systemProviders
    ? { providers: [...(userLlm.systemProviders || []), ...(userLlm.providers || [])], models: userLlm.modelOptions || {} }
    : { providers: settings?.llmProviders || [], models: settings?.llmModels || {} };
  const models = {};
  for (const [providerId, rows] of Object.entries(source.models || {})) {
    models[providerId] = (Array.isArray(rows) ? rows : [])
      .filter((row) => row && typeof row.id === 'string')
      .map((row) => ({
        id: row.id,
        label: row.label || row.id,
        thinkingLevels: Array.isArray(row.thinkingLevels) ? row.thinkingLevels : [],
      }));
  }
  return {
    providers: (source.providers || [])
      .filter((provider) => provider && typeof provider.id === 'string')
      .map((provider) => ({ id: provider.id, name: provider.name || provider.id })),
    models,
  };
}

/** The role a composer's picker speaks for: the session's own role, else whoever last took over. */
export function targetRoleId(team, conversation) {
  return conversation?.roleId || team?.activeRoleId || team?.leadRoleId || '';
}

/** The resolved model view of one role, as the team endpoint reported it. */
export function roleLlm(team, roleId) {
  if (!team || !roleId) return null;
  return (team.roles || []).find((role) => role.id === roleId)?.llm || null;
}

export function catalogModel(catalog, providerId, modelId) {
  const rows = catalog?.models?.[providerId];
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row.id === modelId) || null;
}

export function catalogProviderName(catalog, providerId) {
  return (catalog?.providers || []).find((provider) => provider.id === providerId)?.name || providerId || '';
}

/** What the trigger prints for the model half: the catalog label, or the raw id when stale. */
export function modelLabel(catalog, selection) {
  const entry = catalogModel(catalog, selection?.providerId, selection?.modelId);
  return entry?.label || selection?.modelId || '未选择模型';
}

/** `模型 · 档位`; the effort half disappears for a model that declares no levels. */
export function triggerLabel(catalog, selection) {
  const model = modelLabel(catalog, selection);
  const level = selection?.thinkingLevel || '';
  return level ? `${model} · ${level}` : model;
}

/** Thinking levels of the model a selection points at; empty when it declares none. */
export function effortLevels(catalog, selection) {
  const entry = catalogModel(catalog, selection?.providerId, selection?.modelId);
  return entry?.thinkingLevels || [];
}

/**
 * Provider groups for the menu, optionally filtered by a search query.
 *
 * Matching is per group: a provider survives when any of its models matches, so the sticky
 * headings in the rendered list never appear over an empty block.
 */
export function providerGroups(catalog, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const groups = [];
  for (const provider of catalog?.providers || []) {
    const rows = (catalog?.models?.[provider.id] || [])
      .filter((model) => !needle
        || String(model.label).toLowerCase().includes(needle)
        || String(model.id).toLowerCase().includes(needle)
        || String(provider.name).toLowerCase().includes(needle));
    if (rows.length) groups.push({ id: provider.id, name: provider.name, models: rows });
  }
  return groups;
}

/** How many models the menu can show before a search box earns its place. */
export function modelCount(catalog) {
  return Object.values(catalog?.models || {}).reduce((total, rows) => total + (Array.isArray(rows) ? rows.length : 0), 0);
}

/** Whether the selection the backend reported still exists in the catalog we can see. */
export function isRoutable(catalog, llm) {
  if (!llm) return false;
  if (llm.routable === false) return false;
  return Boolean(catalogModel(catalog, llm.selection?.providerId, llm.selection?.modelId));
}

export function sameSelection(a, b) {
  if (!a || !b) return false;
  return a.providerId === b.providerId
    && a.modelId === b.modelId
    && (a.thinkingLevel || '') === (b.thinkingLevel || '');
}
