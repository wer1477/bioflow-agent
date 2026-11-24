import fs from 'node:fs';
import path from 'node:path';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { Skill } from '../config/skill_config_store.js';
import { buildSkillMarkdown } from '../config/skill_config_store.js';
import type { CatalogServerEntry } from '../types.js';
import { assetVersion } from './asset_provenance.js';

/**
 * Two-level tool library.
 *
 * Layer 1 is the domain index (`toollibrary/index.md`), layer 2 is one domain's
 * tool catalog (`toollibrary/<domain>/index.md`). The disk tree is a curated
 * *display* layer: whether a capability exists is decided by the agent bindings
 * and the live MCP catalog, never by these files. Configured-but-unlisted
 * capabilities stay reachable through a synthetic `Unclassified` domain, and listed
 * capabilities that are not bound are hidden with a warning.
 *
 * The executor is a pure module over an injected capability snapshot so the
 * parser can be tested with a temporary root and fake skills/servers.
 */

export const UNCLASSIFIED_DOMAIN_NAME = 'Unclassified';
export const DOMAIN_INDEX_FILE = 'index.md';
/** One catalog page never exceeds this many characters (`index` is unbounded but small). */
export const TOOLLIBRARY_CATALOG_CHAR_BUDGET = 30000;
export const TOOLLIBRARY_DESCRIPTION_WARN_CHARS = 700;
export const TOOLLIBRARY_NAME_WARN_CHARS = 120;
/** One skill load inlines at most this many characters of resource bodies. */
export const SKILL_RESOURCE_INLINE_BUDGET = 8000;
const WARNING_LIMIT = 20;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export type ToolLibrarySkill = Pick<Skill, 'id' | 'name' | 'description' | 'instructions' | 'resources'> & {
  directory?: string;
};

export interface ToolLibraryContext {
  /** Absolute tool-library root. Tests inject a temporary directory. */
  root: string;
  /** Capabilities the current agent may load: enabled skills bound to the agent. */
  skills: ToolLibrarySkill[];
  /** Catalog of the MCP servers connected for this agent. */
  mcpServers: CatalogServerEntry[];
  /** Public MCP tool name (`<server>__<tool>`) to its OpenAI tool schema. */
  mcpTools: Map<string, ChatCompletionTool>;
}

export interface ToolLibraryCatalogEntry {
  name: string;
  kind: 'skill' | 'mcp';
  id: string;
  description: string;
  /** Optional published-asset version from `<skill dir>/provenance.json`. */
  version?: string;
}

interface DomainCatalog {
  name: string;
  description: string;
  entries: ToolLibraryCatalogEntry[];
  /** Entry-level problems, only reported when this domain is opened. */
  warnings: string[];
}

interface CatalogState {
  domains: DomainCatalog[];
  /** Index-level problems, reported by both actions. */
  warnings: string[];
}

export interface RootIndexRow {
  name: string;
  description: string;
}

/** One L1 row after the root index and the domain directories have been reconciled. */
export interface ToolLibraryDomainIndexEntry {
  name: string;
  description: string;
}

/**
 * What an agent can actually load, for scoping the L1 prompt block.
 *
 * Both lists are the resolved runtime bindings (enabled ∩ bound), not the raw
 * configuration: a disabled skill or MCP server must not keep a domain alive.
 */
export interface ToolLibraryPromptVisibility {
  skillIds: readonly string[];
  mcpServerIds: readonly string[];
}

interface VisibleCapabilities {
  skills: Map<string, { name: string; description: string }>;
  mcpTools: Map<string, { name: string; description: string }>;
}

export interface ToolLoadOutcome {
  result: Record<string, unknown>;
  /** Present when the load registered one MCP tool schema for the next turn. */
  mcpTool?: ChatCompletionTool;
}

export interface ToolLibraryBrowseResult extends Record<string, unknown> {}

/** One curated domain as stored on disk, before any live visibility reconciliation. */
export interface StaticToolLibraryDomain {
  name: string;
  description: string;
  entries: ToolLibraryCatalogEntry[];
  warnings: string[];
}

/** L1: domain index. L2: one domain's tool catalog. */
export function executeToolLibraryBrowse(args: Record<string, unknown>, context: ToolLibraryContext): ToolLibraryBrowseResult {
  const requestedDomain = String(args.domain ?? '').trim();
  const state = buildCatalogState(context);

  if (!requestedDomain) {
    return {
      ok: true,
      action: 'index',
      domains: state.domains
        .filter((domain) => domain.entries.length > 0)
        .map((domain) => ({ name: domain.name, description: domain.description, tools: domain.entries.length })),
      warnings: state.warnings,
    };
  }

  const domain = state.domains.find((item) => item.name === requestedDomain);
  if (!domain) {
    return {
      ok: false,
      error: `Unknown tool-library domain '${requestedDomain}'. Use an exact domain name from the <tool_library_domains> block in the system prompt, or call toollibrary without a domain to read the runtime index.`,
    };
  }

  const page = paginateEntries(domain.entries, args);
  return {
    ok: true,
    action: 'catalog',
    domain: domain.name,
    entries: page.entries,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    has_more: page.hasMore,
    warnings: mergeWarnings(domain.warnings, state.warnings),
  };
}

/**
 * `toolload` tool/skill branch: resolve one id from a catalog. MCP resources are
 * handled by the dispatcher because they need a live server connection.
 */
export function executeToolLoad(args: Record<string, unknown>, context: ToolLibraryContext): ToolLoadOutcome {
  const rawId = String(args.id ?? '').trim();
  if (!rawId) {
    return { result: { ok: false, error: "toolload requires id (a skill id or an MCP tool name from a toollibrary catalog), or resource/server for MCP resources." } };
  }

  const skill = findSkill(context.skills, rawId);
  if (skill) {
    return {
      result: { ok: true, action: 'skill', skillId: skill.id, skillName: skill.name, content: formatLoadedSkill(skill) },
    };
  }

  const direct = context.mcpTools.get(rawId);
  if (direct) {
    return { result: { ok: true, action: 'mcp_tool', id: rawId }, mcpTool: direct };
  }

  // The model may drop the `<server>_` prefix when the raw MCP tool name is unique.
  const suffixed = [...context.mcpTools.entries()].filter(([publicName]) => publicName.endsWith(`_${rawId}`) || publicName.endsWith(`__${rawId}`));
  if (suffixed.length === 1) {
    const [publicName, tool] = suffixed[0];
    return { result: { ok: true, action: 'mcp_tool', id: publicName }, mcpTool: tool };
  }
  if (suffixed.length > 1) {
    return { result: { ok: false, error: `MCP tool '${rawId}' is ambiguous; pass the exact public name (${suffixed.map(([name]) => name).join(', ')}).` } };
  }

  return {
    result: {
      ok: false,
      error: `Tool '${rawId}' is not available to this agent. Call toollibrary with a domain and use an exact id from its catalog.`,
    },
  };
}

/**
 * Render one skill load. The SKILL.md body is always complete; resource bodies are
 * inlined up to a shared budget because some skills ship large reference files, and
 * appending all of them would push the whole result past the inline observation limit.
 */
export function formatLoadedSkill(skill: ToolLibrarySkill): string {
  const sections = [`## Skill: ${skill.name}`, buildSkillMarkdown(skill), '', '## Skill Resources'];
  if (!skill.resources.length) {
    sections.push('No resources');
    return sections.join('\n');
  }

  const rendered: string[] = [];
  const listedOnly: string[] = [];
  let used = 0;
  for (const resource of skill.resources) {
    if (resource.encoding !== 'utf8') {
      listedOnly.push(`- ${resource.fileName} (binary, ${resource.size} bytes)`);
      continue;
    }
    const content = resource.content.slice(0, 4000);
    if (used + content.length > SKILL_RESOURCE_INLINE_BUDGET) {
      listedOnly.push(`- ${resource.fileName} (${resource.mimeType}, ${resource.size} bytes)`);
      continue;
    }
    used += content.length;
    rendered.push(`### Resource: ${resource.fileName}\n${content}`);
  }
  if (rendered.length) sections.push(rendered.join('\n\n'));
  if (listedOnly.length) {
    sections.push(
      '[resource content budget exhausted; these resources are not inlined]',
      listedOnly.join('\n'),
    );
  }
  return sections.join('\n');
}

/** Domain/layer view shared by index, catalog and the content-contract tests. */
export function buildCatalogState(context: ToolLibraryContext): CatalogState {
  const warnings: string[] = [];
  const visible = collectVisibleCapabilities(context);

  if (!isDirectory(context.root)) {
    throw new Error(`Tool library root not found: ${context.root}`);
  }

  const domains: DomainCatalog[] = [];
  const listedToolIds = new Set<string>();
  for (const entry of readDomainIndex(context.root, warnings)) {
    const domain = readDomainCatalog(context.root, entry.name, entry.description, warnings);
    const kept: ToolLibraryCatalogEntry[] = [];
    for (const item of domain.entries) {
      if (listedToolIds.has(item.id)) {
        domain.warnings.push(`duplicate_tool_entry: '${item.id}' is already listed in an earlier domain; this entry is ignored.`);
        continue;
      }
      if (!isVisible(visible, item)) {
        domain.warnings.push(`unknown_tool: '${item.id}' is not an enabled capability bound to this agent; the entry is hidden.`);
        continue;
      }
      listedToolIds.add(item.id);
      kept.push(item);
    }
    domain.entries = kept;
    domains.push(domain);
  }

  const unlisted = collectUnlistedEntries(visible, listedToolIds);
  if (unlisted.length) {
    warnings.push(`unlisted_tool: ${unlisted.length} visible capability(ies) are not listed in any domain file; they are exposed under '${UNCLASSIFIED_DOMAIN_NAME}'.`);
    domains.push({
      name: UNCLASSIFIED_DOMAIN_NAME,
      description: 'Runtime fallback domain: capabilities that are configured or connected but not yet listed in any domain index file.',
      entries: unlisted,
      warnings: [],
    });
  }

  return { domains, warnings: capWarnings(warnings) };
}

/**
 * Flat candidate list for a decision model.
 *
 * The list comes from the same live snapshot as `toollibrary` itself, so every id is
 * loadable by `toolload` by construction. A domain filter is applied after reconciliation
 * because the synthetic `Unclassified` domain is only knowable at runtime.
 */
export function collectToolLibraryCandidates(
  context: ToolLibraryContext,
  domain?: string,
): Array<ToolLibraryCatalogEntry & { domain: string }> {
  const state = buildCatalogState(context);
  const requested = String(domain || '').trim();
  const domains = requested ? state.domains.filter((item) => item.name === requested) : state.domains;
  const skillsById = new Map(context.skills.map((skill) => [skill.id, skill]));
  return domains.flatMap((item) => item.entries.map((entry) => {
    const version = entry.kind === 'skill' ? assetVersion(skillsById.get(entry.id)?.directory) : undefined;
    return version ? { ...entry, domain: item.name, version } : { ...entry, domain: item.name };
  }));
}

/**
 * Reconcile the root index with the domain directories on disk.
 *
 * Order: root-index rows first, then unlisted disk domains by directory name. Rows that
 * point at a missing directory are dropped, and disk domains missing from the index get an
 * empty description. Both the L1 browse fallback and the system-prompt renderer read this
 * function, so the two views can never disagree about which domains exist.
 */
export function readDomainIndex(root: string, warnings: string[]): ToolLibraryDomainIndexEntry[] {
  const diskDomains = listDomainDirectories(root);
  if (!diskDomains.length) {
    warnings.push(`missing_index: ${path.join(root, DOMAIN_INDEX_FILE)} does not exist and no domain directory was found.`);
  }

  const indexRows = readRootIndex(root, warnings);
  const ordered: ToolLibraryDomainIndexEntry[] = [];
  const seenDomains = new Set<string>();
  for (const row of indexRows) {
    if (seenDomains.has(row.name)) {
      warnings.push(`duplicate_index_domain: '${row.name}' is listed more than once in the root index; the first row wins.`);
      continue;
    }
    seenDomains.add(row.name);
    if (!diskDomains.includes(row.name)) {
      warnings.push(`unknown_domain: root index lists '${row.name}', but ${path.join(root, row.name)} does not exist; the row is ignored.`);
      continue;
    }
    ordered.push({ name: row.name, description: row.description });
  }
  for (const name of diskDomains) {
    if (seenDomains.has(name)) continue;
    warnings.push(`unlisted_domain: domain directory '${name}' is not listed in the root index; its description is empty.`);
    ordered.push({ name, description: '' });
  }
  return ordered;
}

/**
 * L1 for the system prompt: the capability-domain index as static context.
 *
 * The domain layer is small (~1.3k characters) and changes only when a curator edits the
 * root index, so the model should not spend a discovery turn on it. Only names and
 * descriptions are rendered: tool counts need the live capability snapshot, which does not
 * exist yet when the prompt is assembled.
 *
 * `visibility` scopes the block to the agent that will receive it: a domain is rendered only
 * when at least one of its entries is a capability that agent actually has. Skill entries
 * match by exact id, MCP entries by the `<server>_` prefix of their public name (the form
 * `publicToolName` produces after collapsing separators). Without it the full curated index
 * is rendered, which is what the settings surface and the tests want; `null` means "no
 * domains to declare", either because the display layer is missing/unreadable or because the
 * agent has no capability in any domain. Returning null keeps a broken curation file from
 * failing a run — the no-domain `toollibrary` fallback stays available in that case.
 */
export function renderToolLibraryDomainIndexPrompt(
  root: string,
  visibility?: ToolLibraryPromptVisibility,
): string | null {
  let entries: ToolLibraryDomainIndexEntry[];
  try {
    if (!isDirectory(root)) return null;
    entries = readDomainIndex(root, []);
  } catch {
    return null;
  }
  if (visibility) {
    entries = entries.filter((entry) => domainServesVisibleCapability(root, entry.name, visibility));
  }
  if (!entries.length) return null;
  return [
    '<tool_library_domains>',
    "Capability domains in the tool library. Pass an exact domain name to toollibrary to list that domain's tools.",
    ...entries.map((entry) => entry.description ? `- ${entry.name}：${entry.description}` : `- ${entry.name}`),
    '</tool_library_domains>',
  ].join('\n');
}

export const CLI_CAPABILITIES_FILE = 'cli.md';
/** Hard cap so a growing command list cannot inflate every request. */
export const CLI_CAPABILITIES_CHAR_BUDGET = 4000;

export interface CliCapabilityEntry {
  command: string;
  skillId: string;
  description: string;
}

/**
 * Read `toollibrary/cli.md`: installed command-line capabilities.
 *
 * This file is a display layer exactly like the domain index. It advertises that a
 * command exists; the parameter contract comes from `<command> --describe --format
 * json`, and the workflow/risks/output interpretation still come from `toolload`.
 * An entry is only advertised to an agent that binds the matching skill.
 */
export function readCliCapabilities(root: string, warnings: string[] = []): CliCapabilityEntry[] {
  const file = path.join(root, CLI_CAPABILITIES_FILE);
  if (!fs.existsSync(file)) return [];
  const entries: CliCapabilityEntry[] = [];
  const seen = new Set<string>();
  readLines(file).forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    if (!/^\s*[-*]\s+/.test(line)) return;
    const entry = parseCliBullet(line);
    if (!entry) {
      warnings.push(`malformed_cli_entry: ${CLI_CAPABILITIES_FILE}:${index + 1} is not shaped as "- <command>（skill：<id>）：<description>".`);
      return;
    }
    if (seen.has(entry.command)) {
      warnings.push(`duplicate_cli_command: '${entry.command}' is listed more than once; the first entry wins.`);
      return;
    }
    seen.add(entry.command);
    entries.push(entry);
  });
  return entries;
}

/** `- <command>（skill：<id>）：<description>` with full-width or ASCII punctuation. */
export function parseCliBullet(line: string): CliCapabilityEntry | null {
  const match = line.match(/^\s*[-*]\s+(.+?)\s*[（(]\s*skill\s*[:：]\s*([^）)\n]+?)\s*[）)]\s*[:：]\s*(.+)$/u);
  if (!match) return null;
  const command = match[1].trim();
  const skillId = match[2].trim();
  const description = match[3].trim();
  if (!command || !skillId || !description) return null;
  return { command, skillId, description };
}

/**
 * L1.5 for the system prompt: installed CLIs the agent may run.
 *
 * One line per command removes the "unknown unknown" that made the model write the
 * same pipeline by hand. The block is scoped to the agent's bound skills and capped
 * by `CLI_CAPABILITIES_CHAR_BUDGET`; bodies stay behind `toolload`.
 */
export function renderCliCapabilitiesPrompt(
  root: string,
  visibility?: ToolLibraryPromptVisibility,
): string | null {
  let entries: CliCapabilityEntry[];
  try {
    if (!isDirectory(root)) return null;
    entries = readCliCapabilities(root, []);
  } catch {
    return null;
  }
  if (visibility) {
    const bound = new Set(visibility.skillIds);
    entries = entries.filter((entry) => bound.has(entry.skillId));
  }
  if (!entries.length) return null;

  const head = [
    '<cli_capabilities>',
    'Commands installed on PATH by default; no capability body needs to be loaded before running them.',
  ];
  const tail = [
    'Run `<command> --describe --format json` for the current option contract; call toolload({id:"<skill-id>"}) for the workflow, risks, and output interpretation.',
    '</cli_capabilities>',
  ];
  const build = (kept: string[], omitted: number): string => [
    ...head,
    ...kept,
    ...(omitted ? [`- … ${omitted} more installed command(s) omitted from this prompt.`] : []),
    ...tail,
  ].join('\n');

  const kept: string[] = [];
  let omitted = 0;
  for (const entry of entries) {
    const line = `- \`${entry.command}\` (skill: \`${entry.skillId}\`): ${entry.description}`;
    if (build([...kept, line], omitted).length > CLI_CAPABILITIES_CHAR_BUDGET) {
      omitted += 1;
      continue;
    }
    kept.push(line);
  }
  let result = build(kept, omitted);
  while (result.length > CLI_CAPABILITIES_CHAR_BUDGET && kept.length) {
    kept.pop();
    omitted += 1;
    result = build(kept, omitted);
  }
  return result;
}

/**
 * Does this domain hold at least one capability the agent may load?
 *
 * Reading the domain catalog (not just the root index) is what makes the prompt agree with
 * `toollibrary({domain})`: a role that binds nothing in a domain would only ever get an empty
 * catalog from it, so the domain is not worth a line of context.
 */
function domainServesVisibleCapability(
  root: string,
  domainName: string,
  visibility: ToolLibraryPromptVisibility,
): boolean {
  const skills = new Set(visibility.skillIds);
  const hasMcpEntry = (id: string): boolean => visibility.mcpServerIds.some((serverId) => id.startsWith(`${serverId}_`));
  return readDomainCatalog(root, domainName, '', []).entries
    .some((entry) => entry.kind === 'skill' ? skills.has(entry.id) : hasMcpEntry(entry.id));
}

/**
 * Read the curated domain tree without a live capability snapshot.
 *
 * The settings surface lists every curated capability of every domain; the runtime view
 * additionally reconciles the tree with the capabilities the agent may actually load.
 */
export function readToolLibraryDomains(root: string): { domains: StaticToolLibraryDomain[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!isDirectory(root)) {
    return { domains: [], warnings: [`missing_root: ${root} is not a directory.`] };
  }
  const domains = readDomainIndex(root, warnings).map((entry) => {
    const domain = readDomainCatalog(root, entry.name, entry.description, warnings);
    return { name: domain.name, description: domain.description, entries: domain.entries, warnings: domain.warnings };
  });
  return { domains, warnings: capWarnings(warnings) };
}

function collectVisibleCapabilities(context: ToolLibraryContext): VisibleCapabilities {
  const skills = new Map<string, { name: string; description: string }>();
  for (const skill of context.skills) {
    skills.set(skill.id, { name: skill.name, description: skill.description || 'No description' });
  }
  const mcpTools = new Map<string, { name: string; description: string }>();
  for (const [publicName, tool] of context.mcpTools.entries()) {
    const description = tool.type === 'function' ? tool.function.description || '' : '';
    mcpTools.set(publicName, { name: publicName, description: description || mcpToolDescription(context, publicName) });
  }
  // The server catalog is authoritative for the tool set; the OpenAI schema map is the
  // caller's projection of the same servers, so both should agree. Keeping this loop makes
  // the executor work even when a caller only passes the catalog.
  for (const server of context.mcpServers) {
    for (const tool of server.tools) {
      if (!mcpTools.has(tool.id)) mcpTools.set(tool.id, { name: tool.id, description: tool.description || 'No description' });
    }
  }
  return { skills, mcpTools };
}

function mcpToolDescription(context: ToolLibraryContext, publicName: string): string {
  for (const server of context.mcpServers) {
    const match = server.tools.find((tool) => tool.id === publicName);
    if (match) return match.description || 'No description';
  }
  return 'No description';
}

function isVisible(visible: VisibleCapabilities, entry: ToolLibraryCatalogEntry): boolean {
  return entry.kind === 'skill' ? visible.skills.has(entry.id) : visible.mcpTools.has(entry.id);
}

function collectUnlistedEntries(visible: VisibleCapabilities, listedToolIds: Set<string>): ToolLibraryCatalogEntry[] {
  const entries: ToolLibraryCatalogEntry[] = [];
  for (const [id, skill] of visible.skills.entries()) {
    if (listedToolIds.has(id)) continue;
    entries.push({ name: skill.name, kind: 'skill', id, description: skill.description });
  }
  for (const [id, tool] of visible.mcpTools.entries()) {
    if (listedToolIds.has(id)) continue;
    entries.push({ name: tool.name, kind: 'mcp', id, description: tool.description });
  }
  return sortEntries(entries);
}

function readRootIndex(root: string, warnings: string[]): RootIndexRow[] {
  const file = path.join(root, DOMAIN_INDEX_FILE);
  if (!fs.existsSync(file)) {
    warnings.push(`missing_index: ${file} does not exist; every domain description is empty.`);
    return [];
  }
  const rows: RootIndexRow[] = [];
  for (const line of readLines(file)) {
    const parsed = parseIndexBullet(line);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

/** `- <domain>：<description>` / `- <domain>: <description>` */
export function parseIndexBullet(line: string): RootIndexRow | null {
  const match = line.match(/^\s*[-*]\s+(.+)$/u);
  if (!match) return null;
  const body = match[1].trim();
  const separator = findSeparator(body);
  if (separator < 0) return null;
  const name = body.slice(0, separator).trim();
  const description = body.slice(separator + 1).trim();
  return name ? { name, description } : null;
}

function listDomainDirectories(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(compareCodepoint);
}

function readDomainCatalog(root: string, domainName: string, description: string, globalWarnings: string[]): DomainCatalog {
  const file = path.join(root, domainName, DOMAIN_INDEX_FILE);
  const domain: DomainCatalog = { name: domainName, description, entries: [], warnings: [] };
  if (!fs.existsSync(file)) {
    globalWarnings.push(`missing_domain_index: ${file} does not exist; the domain has no tools.`);
    return domain;
  }
  const byId = new Map<string, ToolLibraryCatalogEntry>();
  const byName = new Map<string, string>();
  readLines(file).forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    if (!/^\s*[-*]\s+/.test(line)) return;
    const entry = parseCatalogBullet(line);
    if (!entry) {
      domain.warnings.push(`malformed_entry: ${domainName}/${DOMAIN_INDEX_FILE}:${index + 1} is not shaped as "- <name>（<kind>：<id>）：<description>".`);
      return;
    }
    if (entry.name.length > TOOLLIBRARY_NAME_WARN_CHARS) {
      domain.warnings.push(`name_exceeds_budget: '${entry.name}' is longer than ${TOOLLIBRARY_NAME_WARN_CHARS} characters.`);
    }
    if (entry.description.length > TOOLLIBRARY_DESCRIPTION_WARN_CHARS) {
      domain.warnings.push(`description_exceeds_budget: '${entry.id}' has a description longer than ${TOOLLIBRARY_DESCRIPTION_WARN_CHARS} characters.`);
    }
    const existingId = byId.get(entry.id);
    if (existingId) {
      domain.warnings.push(`duplicate_entry_id: '${entry.id}' is listed more than once; the first entry wins.`);
      return;
    }
    const existingName = byName.get(entry.name);
    if (existingName) {
      domain.warnings.push(`duplicate_entry_name: '${entry.name}' is used by both '${existingName}' and '${entry.id}'.`);
    } else {
      byName.set(entry.name, entry.id);
    }
    byId.set(entry.id, entry);
  });
  domain.entries = [...byId.values()];
  return domain;
}

/** `- <name>（<kind>：<id>）：<description>` with full-width or ASCII punctuation. */
export function parseCatalogBullet(line: string): ToolLibraryCatalogEntry | null {
  const match = line.match(/^\s*[-*]\s+(.+?)\s*[（(]\s*(skill|mcp)\s*[:：]\s*([^）)\n]+?)\s*[）)]\s*[:：]\s*(.+)$/u);
  if (!match) return null;
  const name = match[1].trim();
  const kind = match[2] as 'skill' | 'mcp';
  const id = match[3].trim();
  const description = match[4].trim();
  if (!name || !id || !description) return null;
  return { name, kind, id, description };
}

function readLines(file: string): string[] {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return raw.split(/\r?\n/);
}

function findSeparator(value: string): number {
  const full = value.indexOf('：');
  const ascii = value.indexOf(':');
  if (full < 0) return ascii;
  if (ascii < 0) return full;
  return Math.min(full, ascii);
}

function findSkill(skills: ToolLibrarySkill[], idOrName: string): ToolLibrarySkill | null {
  const exactId = skills.find((skill) => skill.id === idOrName);
  if (exactId) return exactId;
  const normalized = normalizeText(idOrName);
  if (!normalized) return null;
  const exactName = skills.filter((skill) => normalizeText(skill.name) === normalized);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) return null;
  const partial = skills.filter((skill) => normalizeText(skill.name).includes(normalized));
  return partial.length === 1 ? partial[0] : null;
}

function normalizeText(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sortEntries(entries: ToolLibraryCatalogEntry[]): ToolLibraryCatalogEntry[] {
  return [...entries].sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function paginateEntries(entries: ToolLibraryCatalogEntry[], args: Record<string, unknown>): {
  entries: ToolLibraryCatalogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
} {
  const sorted = sortEntries(entries);
  const total = sorted.length;
  const offset = clampInteger(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = clampInteger(args.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const page: ToolLibraryCatalogEntry[] = [];
  let chars = 0;
  for (let index = offset; index < total; index += 1) {
    const entry = sorted[index];
    const size = JSON.stringify(entry).length + 2;
    if (page.length > 0 && chars + size > TOOLLIBRARY_CATALOG_CHAR_BUDGET) break;
    if (page.length >= limit) break;
    page.push(entry);
    chars += size;
  }
  return { entries: page, total, offset, limit, hasMore: offset + page.length < total };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function mergeWarnings(...groups: string[][]): string[] {
  return capWarnings(groups.flat());
}

function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= WARNING_LIMIT) return warnings;
  return [...warnings.slice(0, WARNING_LIMIT), `${warnings.length - WARNING_LIMIT} more warnings omitted.`];
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export { compareCodepoint, normalizeText };
