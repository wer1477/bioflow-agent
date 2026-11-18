/**
 * Agent settings view model: CoreTool, ToolLibrary and KnowledgeBase selections.
 *
 * The backend serves the Tool Library and Knowledge Base grouped by curated domain. Agents
 * bind skills per id, MCP servers per server id, and knowledge entries per `<domain>/<entry>`
 * id, so these helpers translate a domain group into those selection lists and back. Pure
 * functions only: the components stay thin and the toggle semantics are testable without a
 * DOM.
 */

/** Add or remove one id, preserving the existing order. */
export function toggleId(ids = [], id) {
  const next = new Set(ids || []);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return [...next];
}

/**
 * Group one domain into bindable skills, bindable MCP servers, and entries that cannot be
 * bound (an MCP tool whose server no longer exists in configuration).
 */
export function toolLibraryDomainGroup(domain) {
  const skills = [];
  const servers = new Map();
  const unresolved = [];
  const seenSkills = new Set();
  for (const entry of domain?.entries || []) {
    if (entry.kind === 'skill') {
      if (seenSkills.has(entry.id)) continue;
      seenSkills.add(entry.id);
      skills.push(entry);
      continue;
    }
    if (entry.kind !== 'mcp') continue;
    if (!entry.serverId) {
      unresolved.push(entry);
      continue;
    }
    const existing = servers.get(entry.serverId);
    if (existing) {
      existing.tools.push(entry.name);
      existing.available = existing.available || entry.available;
      existing.enabled = existing.enabled || entry.enabled;
      continue;
    }
    servers.set(entry.serverId, {
      serverId: entry.serverId,
      name: entry.serverName || entry.serverId,
      tools: [entry.name],
      available: Boolean(entry.available),
      enabled: Boolean(entry.enabled),
    });
  }
  return { skills, servers: [...servers.values()], unresolved };
}

/** Selection summary for one domain; unavailable entries never count toward "all". */
export function toolLibraryDomainState(domain, skillIds = [], serverIds = []) {
  const group = toolLibraryDomainGroup(domain);
  const skills = new Set(skillIds || []);
  const servers = new Set(serverIds || []);
  const bindableSkills = group.skills.filter((skill) => skill.available);
  const bindableServers = group.servers.filter((server) => server.available);
  const total = bindableSkills.length + bindableServers.length;
  const selected = bindableSkills.filter((skill) => skills.has(skill.id)).length
    + bindableServers.filter((server) => servers.has(server.serverId)).length;
  return { ...group, total, selected, checked: total > 0 && selected === total };
}

/** Select or clear every bindable entry of one domain; returns both selection lists. */
export function toggleToolLibraryDomain(domain, skillIds = [], serverIds = []) {
  const group = toolLibraryDomainGroup(domain);
  const { checked } = toolLibraryDomainState(domain, skillIds, serverIds);
  const nextSkills = new Set(skillIds || []);
  const nextServers = new Set(serverIds || []);
  const select = !checked;
  for (const skill of group.skills) {
    if (select && !skill.available) continue;
    if (select) nextSkills.add(skill.id);
    else nextSkills.delete(skill.id);
  }
  for (const server of group.servers) {
    if (select && !server.available) continue;
    if (select) nextServers.add(server.serverId);
    else nextServers.delete(server.serverId);
  }
  return { skillIds: [...nextSkills], mcpServerIds: [...nextServers] };
}

/** Every bindable id in the catalog, used by the section-level select-all control. */
export function toolLibrarySelection(domains = []) {
  const skills = new Set();
  const servers = new Set();
  for (const domain of domains || []) {
    const group = toolLibraryDomainGroup(domain);
    for (const skill of group.skills) if (skill.available) skills.add(skill.id);
    for (const server of group.servers) if (server.available) servers.add(server.serverId);
  }
  return { skillIds: [...skills], mcpServerIds: [...servers] };
}

/** Every knowledge entry id in the catalog, used by the section-level select-all control. */
export function knowledgeBaseSelection(domains = []) {
  const ids = new Set();
  for (const domain of domains || []) {
    for (const entry of domain?.entries || []) if (entry?.id) ids.add(entry.id);
  }
  return [...ids];
}

/** Selection summary for one knowledge domain; the domain box is checked when all its entries are. */
export function knowledgeBaseDomainState(domain, selected = []) {
  const entries = (domain?.entries || []).filter((entry) => entry?.id);
  const selectedSet = new Set(selected || []);
  const chosen = entries.filter((entry) => selectedSet.has(entry.id)).length;
  return {
    total: entries.length,
    selected: chosen,
    checked: entries.length > 0 && chosen === entries.length,
    indeterminate: chosen > 0 && chosen < entries.length,
  };
}

/** Select or clear every entry of one knowledge domain; unrelated ids are left alone. */
export function toggleKnowledgeBaseDomain(domain, selected = []) {
  const { checked } = knowledgeBaseDomainState(domain, selected);
  const next = new Set(selected || []);
  for (const entry of domain?.entries || []) {
    if (!entry?.id) continue;
    if (checked) next.delete(entry.id);
    else next.add(entry.id);
  }
  return [...next];
}
