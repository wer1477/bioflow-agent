import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { KNOWLEDGEBASE_ROOT } from '../../paths.js';
import { clampNumber } from './shared.js';

/**
 * Knowledge base: a two-level, human-curated body of reference knowledge.
 *
 * Disk contract (see `docs/knowledgebase-mechanism.md`):
 *
 *   knowledgebase/
 *     skill.md                 <- level-1 index: one line per domain
 *     <domain>/
 *       <entry>/
 *         skill.md             <- level-2 entry: frontmatter + knowledge body
 *         resources/           <- optional viewable material (no executables)
 *
 * The directory tree is the source of truth. The index file only adds domain
 * descriptions; a missing or stale index degrades to warnings instead of hiding
 * content. Entries are reference material only: this module never executes a
 * resource.
 */

const INDEX_FILE = 'skill.md';
const ENTRY_FILE = 'skill.md';
const RESOURCES_DIRECTORY = 'resources';
const DEFAULT_CATALOG_LIMIT = 100;
const MAX_CATALOG_LIMIT = 200;
const INLINE_RESOURCE_CHARS = 2000;
const INLINE_RESOURCE_TOTAL_CHARS = 4000;
/**
 * The catalog page is filled until this many characters of entries accumulate.
 * It matches the knowledge base observation inline budget (30,000): a domain catalog
 * is meant to reach the model in one piece, and only larger domains page.
 */
const CATALOG_CHAR_BUDGET = 30000;
const ENTRY_BODY_BUDGET_CHARS = 28000;
const ENTRY_DESCRIPTION_BUDGET_CHARS = 700;
const MAX_WARNINGS = 20;
const MAX_RESOURCE_COUNT = 40;
const MAX_NAME_CHARS = 120;

const EXECUTABLE_EXTENSIONS = new Set([
  '.py', '.pyw', '.sh', '.bash', '.zsh', '.ps1', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.ipynb',
  '.exe', '.bat', '.cmd', '.r', '.rmd', '.pl', '.rb', '.jar', '.bin',
]);

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.html', '.htm', '.svg',
  '.xml', '.toml', '.ini', '.log',
]);

const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
};

/** One entry as exposed by a domain catalog. */
export interface KnowledgeBaseEntrySummary {
  id: string;
  name: string;
  description: string;
}

interface KnowledgeBaseIndex {
  descriptions: Map<string, string>;
  order: string[];
  warnings: string[];
}

interface ParsedEntry {
  name: string;
  description: string;
  content: string;
  warnings: string[];
}

export interface KnowledgeBaseExecutorOptions {
  /** Absolute knowledgebase root. Defaults to the repository `agent-client/knowledgebase`. */
  root?: string;
  /**
   * Entry ids (`<domain>/<entry>`) this caller may browse. `undefined` keeps every entry
   * visible for direct callers; an empty array means the agent has no knowledge entry
   * configured.
   */
  entries?: readonly string[];
}

/** One curated domain with its entry summaries, as shown by the settings surface. */
export interface StaticKnowledgeBaseDomain {
  name: string;
  description: string;
  entries: KnowledgeBaseEntrySummary[];
}

/**
 * Execute one `knowledgebase` action. Expected user/model mistakes come back as
 * `{ ok: false, error }`; unexpected filesystem failures throw and are converted
 * by the CoreTool entry point.
 */
export function executeKnowledgeBase(
  args: Record<string, unknown>,
  options: KnowledgeBaseExecutorOptions = {},
): Record<string, unknown> {
  const action = String(args.action || '').trim();
  switch (action) {
    case 'index': return loadIndex(options);
    case 'catalog': return loadDomainCatalog(options, args);
    case 'read': return readEntry(options, args);
    default:
      return {
        ok: false,
        error: `Unknown knowledgebase action "${action}". Use one of: index, catalog, read.`,
      };
  }
}

/**
 * Every entry id on disk, in curated domain order. Used to expand a legacy domain-based
 * agent binding, so the persisted list reads in the same order as the settings page.
 */
export function listKnowledgeBaseEntryIds(options: KnowledgeBaseExecutorOptions = {}): string[] {
  const root = resolveRoot(options);
  return listKnowledgeBaseDomainNames(options)
    .flatMap((domain) => listEntryDirectories(path.join(root, domain)).map((entry) => `${domain}/${entry}`));
}

/** Domain names on disk, declared in index order. Used by the legacy agent migration. */
export function listKnowledgeBaseDomainNames(options: KnowledgeBaseExecutorOptions = {}): string[] {
  const root = resolveRoot(options);
  const names = listDomainNames(root);
  const index = readDomainIndex(root, []);
  return [...index.order.filter((name) => names.includes(name)), ...names.filter((name) => !index.order.includes(name)).sort(compareText)];
}

/**
 * Read the curated domain tree for the settings surface.
 *
 * Unlike `index`/`catalog` this never filters by an agent scope and never throws on a
 * malformed entry: the settings page must be able to show (and warn about) drift while
 * still letting the user configure what is readable.
 */
export function readKnowledgeBaseDomains(
  options: KnowledgeBaseExecutorOptions = {},
): { domains: StaticKnowledgeBaseDomain[]; warnings: string[] } {
  const root = resolveRoot(options);
  const warnings: string[] = [];
  const names = listDomainNames(root);
  const index = readDomainIndex(root, warnings);
  const ordered = [...index.order.filter((name) => names.includes(name)), ...names.filter((name) => !index.order.includes(name)).sort(compareText)];
  const domains = ordered.map((name) => {
    const entries: KnowledgeBaseEntrySummary[] = [];
    for (const entryDirectory of listEntryDirectories(path.join(root, name))) {
      const id = `${name}/${entryDirectory}`;
      try {
        const parsed = parseEntryFile(path.join(root, name, entryDirectory));
        entries.push({ id, name: parsed.name, description: parsed.description });
        warnings.push(...parsed.warnings);
      } catch (error) {
        warnings.push(`malformed_entry: "${id}" was skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    entries.sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
    return { name, description: index.descriptions.get(name) || '', entries };
  });
  return { domains, warnings: capWarnings(warnings) };
}

/** One knowledge entry as rendered by the read-only settings viewer. */
export interface KnowledgeBaseEntryView {
  id: string;
  name: string;
  description: string;
  content: string;
  resources: Array<{ path: string; mimeType: string; size: number; encoding: string }>;
  warnings: string[];
}

export type KnowledgeBaseEntryViewResult =
  | { ok: true; entry: KnowledgeBaseEntryView }
  | { ok: false; reason: 'invalid_id' | 'not_found' | 'malformed'; error: string };

/**
 * Read one entry for the settings viewer: the full body plus resource metadata.
 *
 * Unlike the runtime `read` action this never applies an agent scope and never
 * truncates the body (the content contract already caps entries at 28k chars).
 * Resource bodies stay out of the payload; the viewer only lists them.
 */
export function readKnowledgeBaseEntryForView(
  entryId: string,
  options: KnowledgeBaseExecutorOptions = {},
): KnowledgeBaseEntryViewResult {
  const root = resolveRoot(options);
  const parsedId = normalizeEntryId(String(entryId || ''));
  if (!parsedId) {
    return { ok: false, reason: 'invalid_id', error: 'Entry id must look like "<domain>/<entry>".' };
  }
  if (!listDomainNames(root).includes(parsedId.domain)) {
    return { ok: false, reason: 'not_found', error: `Domain "${parsedId.domain}" was not found.` };
  }
  const entryPath = path.join(root, parsedId.domain, parsedId.entry);
  assertInside(root, entryPath);
  if (!fs.existsSync(path.join(entryPath, ENTRY_FILE))) {
    return { ok: false, reason: 'not_found', error: `Entry "${parsedId.id}" was not found.` };
  }

  let parsed: ParsedEntry;
  let resources: Record<string, unknown>[];
  let warnings: string[];
  try {
    parsed = parseEntryFile(entryPath);
    const listing = readEntryResources(root, entryPath, parsedId.id);
    resources = listing.resources;
    warnings = [...parsed.warnings, ...listing.warnings];
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed',
      error: `Entry "${parsedId.id}" is malformed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    entry: {
      id: parsedId.id,
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      resources: resources.map((resource) => ({
        path: String(resource.path || ''),
        mimeType: String(resource.mimeType || ''),
        size: Number(resource.size) || 0,
        encoding: String(resource.encoding || ''),
      })),
      warnings: capWarnings(warnings),
    },
  };
}

/** Summarize every visible domain: level-1 of the progressive disclosure contract. */
function loadIndex(options: KnowledgeBaseExecutorOptions): Record<string, unknown> {
  const root = resolveRoot(options);
  const allowed = allowedEntryIds(options);
  const scopedDomains = allowed ? allowedDomainNames(allowed) : null;
  const warnings: string[] = [];
  const allDomains = listDomainNames(root);
  const domainNames = scopedDomains ? allDomains.filter((name) => scopedDomains.has(name)) : allDomains;
  const index = readDomainIndex(root, warnings);
  const startOrder = [
    ...index.order.filter((name) => domainNames.includes(name)),
    ...domainNames.filter((name) => !index.order.includes(name)).sort(compareText),
  ];

  const domains = startOrder.map((name) => {
    const entriesInDomain = listEntryDirectories(path.join(root, name));
    return {
      name,
      description: index.descriptions.get(name) || '',
      entries: allowed ? entriesInDomain.filter((entry) => allowed.has(`${name}/${entry}`)).length : entriesInDomain.length,
    };
  });

  for (const name of domainNames) {
    if (!index.order.includes(name)) warnings.push(`unlisted_domain: "${name}" is not listed in ${INDEX_FILE}; its description is empty.`);
  }
  for (const name of index.order) {
    if (scopedDomains && !scopedDomains.has(name)) continue;
    if (!allDomains.includes(name)) warnings.push(`unknown_domain: "${name}" is listed in ${INDEX_FILE} but has no directory.`);
  }

  return {
    ok: true,
    action: 'index',
    domains,
    ...(allowed && domains.length === 0 ? { note: 'No knowledge entries are enabled for this agent.' } : {}),
    warnings: capWarnings(warnings),
  };
}

/** List one domain's entries with name + description: level-2. */
function loadDomainCatalog(options: KnowledgeBaseExecutorOptions, args: Record<string, unknown>): Record<string, unknown> {
  const root = resolveRoot(options);
  const domain = String(args.domain || '').trim();
  if (!domain) {
    return { ok: false, error: 'knowledgebase catalog requires a domain. Use action="index" to see the available domains.' };
  }
  const allowed = allowedEntryIds(options);
  if (allowed && !allowedDomainNames(allowed).has(domain)) {
    return { ok: false, error: `Domain "${domain}" is not enabled for this agent. Use action="index" to see the available domains.` };
  }
  if (!listDomainNames(root).includes(domain)) {
    return { ok: false, error: `Domain "${domain}" was not found. Use action="index" to see the available domains.` };
  }

  const warnings: string[] = [];
  const entries: KnowledgeBaseEntrySummary[] = [];
  const seenNames = new Map<string, string>();
  for (const entryDirectory of listEntryDirectories(path.join(root, domain))) {
    const id = `${domain}/${entryDirectory}`;
    if (allowed && !allowed.has(id)) continue;
    try {
      const parsed = parseEntryFile(path.join(root, domain, entryDirectory));
      const duplicate = seenNames.get(parsed.name);
      if (duplicate) warnings.push(`duplicate_entry_name: "${domain}" has more than one entry named "${parsed.name}" ("${duplicate}" and "${id}").`);
      else seenNames.set(parsed.name, id);
      entries.push({ id, name: parsed.name, description: parsed.description });
      warnings.push(...parsed.warnings);
    } catch (error) {
      warnings.push(`malformed_entry: "${id}" was skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  entries.sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
  const total = entries.length;
  const offset = clampNumber(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampNumber(args.limit, DEFAULT_CATALOG_LIMIT, 1, MAX_CATALOG_LIMIT);
  // Fill one page up to the character budget (and the explicit entry limit) so a
  // catalog always reaches the model without the observation layer cutting it.
  const page: KnowledgeBaseEntrySummary[] = [];
  let usedChars = 0;
  for (const entry of entries.slice(offset)) {
    if (page.length >= limit) break;
    const entryChars = JSON.stringify(entry).length + 2;
    if (page.length > 0 && usedChars + entryChars > CATALOG_CHAR_BUDGET) break;
    page.push(entry);
    usedChars += entryChars;
  }

  return {
    ok: true,
    action: 'catalog',
    domain,
    entries: page,
    total,
    offset,
    limit,
    has_more: offset + page.length < total,
    warnings: capWarnings(warnings),
  };
}

/** Load one entry body plus its viewable resources. */
function readEntry(options: KnowledgeBaseExecutorOptions, args: Record<string, unknown>): Record<string, unknown> {
  const root = resolveRoot(options);
  const requested = String(args.entry || '').trim();
  const domainArgument = String(args.domain || '').trim();
  if (!requested) {
    return { ok: false, error: 'knowledgebase read requires an entry id from a domain catalog.' };
  }

  const parsedId = requested.includes('/') ? normalizeEntryId(requested) : (domainArgument ? normalizeEntryId(`${domainArgument}/${requested}`) : null);
  if (!parsedId) {
    return { ok: false, error: 'Entry id must look like "<domain>/<entry>" (for example "Bioinformatics/pysam"). Use action="catalog" to get exact entry ids.' };
  }
  if (requested.includes('/') && domainArgument && parsedId.domain !== domainArgument) {
    return { ok: false, error: `Entry "${requested}" does not belong to domain "${domainArgument}".` };
  }
  if (!listDomainNames(root).includes(parsedId.domain)) {
    return { ok: false, error: `Domain "${parsedId.domain}" was not found. Use action="index" to see the available domains.` };
  }
  const allowed = allowedEntryIds(options);
  if (allowed && !allowed.has(parsedId.id)) {
    return { ok: false, error: `Entry "${parsedId.id}" is not enabled for this agent. Use action="index" to see the available domains.` };
  }

  const entryPath = path.join(root, parsedId.domain, parsedId.entry);
  assertInside(root, entryPath);
  if (!fs.existsSync(path.join(entryPath, ENTRY_FILE))) {
    return { ok: false, error: `Entry "${parsedId.id}" was not found. Use action="catalog" with domain="${parsedId.domain}" to see the available entries.` };
  }

  const parsed = parseEntryFile(entryPath);
  const resourceListing = readEntryResources(root, entryPath, parsedId.id);
  return {
    ok: true,
    action: 'read',
    id: parsedId.id,
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    resources: resourceListing.resources,
    warnings: capWarnings([...parsed.warnings, ...resourceListing.warnings]),
  };
}

/**
 * Flat candidate list for a decision model: every entry (or one domain), with the same
 * id/name/description that `catalog` exposes. Malformed entries are reported as warnings
 * and skipped, matching the browse path.
 */
export function listKnowledgeBaseCandidates(
  options: KnowledgeBaseExecutorOptions = {},
  domain?: string,
): { candidates: Array<KnowledgeBaseEntrySummary & { domain: string }>; warnings: string[] } {
  const root = resolveRoot(options);
  const allowed = allowedEntryIds(options);
  const scopedDomains = allowed ? allowedDomainNames(allowed) : null;
  const warnings: string[] = [];
  const availableDomains = listDomainNames(root);
  const domains = domain ? [domain] : availableDomains;
  const candidates: Array<KnowledgeBaseEntrySummary & { domain: string }> = [];
  for (const name of domains) {
    if (domain && !availableDomains.includes(domain)) {
      warnings.push(`unknown_domain: "${domain}" was not found.`);
      continue;
    }
    if (scopedDomains && !scopedDomains.has(name)) {
      if (domain) warnings.push(`domain_not_enabled: "${name}" is not enabled for this agent.`);
      continue;
    }
    for (const entryDirectory of listEntryDirectories(path.join(root, name))) {
      const id = `${name}/${entryDirectory}`;
      if (allowed && !allowed.has(id)) continue;
      try {
        const parsed = parseEntryFile(path.join(root, name, entryDirectory));
        candidates.push({ id, name: parsed.name, description: parsed.description, domain: name });
      } catch (error) {
        warnings.push(`malformed_entry: "${id}" was skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  candidates.sort((left, right) => compareText(left.id, right.id));
  return { candidates, warnings: capWarnings(warnings) };
}

/**
 * Read the entries a decision model selected, as one bounded result.
 *
 * Only the selected entries are returned: that is the whole point of `action="select"`.
 * A body that would push the page over the knowledgebase inline budget is truncated and
 * flagged rather than dropped, so a large entry never silently turns into an empty result.
 */
export function readKnowledgeBaseEntries(
  options: KnowledgeBaseExecutorOptions,
  ids: readonly string[],
  charBudget = CATALOG_CHAR_BUDGET,
): { entries: Record<string, unknown>[]; warnings: string[] } {
  const root = resolveRoot(options);
  const warnings: string[] = [];
  const entries: Record<string, unknown>[] = [];
  let used = 0;
  for (const id of ids) {
    const result = readEntry(options, { entry: id });
    if (result.ok !== true) {
      warnings.push(`unreadable_entry: "${id}" was not found.`);
      continue;
    }
    const size = JSON.stringify(result).length;
    if (used + size <= charBudget) {
      entries.push(result);
      used += size;
      continue;
    }
    const remaining = charBudget - used;
    const content = typeof result.content === 'string' ? result.content : '';
    if (remaining > 1000 && content) {
      const keep = Math.max(1000, remaining - JSON.stringify({ ...result, content: '' }).length - 200);
      entries.push({ ...result, content: `${content.slice(0, keep)}\n[truncated to the knowledgebase budget]`, truncated: true });
      used = charBudget;
      warnings.push(`content_truncated: "${id}" was shortened to keep the select result inside the knowledgebase budget.`);
      continue;
    }
    warnings.push(`content_dropped: "${id}" did not fit the remaining knowledgebase budget.`);
  }
  return { entries, warnings: capWarnings(warnings) };
}

/** `undefined` means no agent scope; an empty set means the agent may read nothing. */
function allowedEntryIds(options: KnowledgeBaseExecutorOptions): Set<string> | null {
  if (options.entries === undefined) return null;
  return new Set(options.entries.map((entry) => String(entry).trim()).filter(Boolean));
}

/** Domains that contain at least one allowed entry, derived from the flat entry list. */
function allowedDomainNames(entries: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const id of entries) {
    const separator = id.indexOf('/');
    if (separator > 0) names.add(id.slice(0, separator));
  }
  return names;
}

/** Resolve the configured knowledgebase root; a missing root is a real failure. */
function resolveRoot(options: KnowledgeBaseExecutorOptions): string {
  const root = path.resolve(options.root || KNOWLEDGEBASE_ROOT);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`knowledgebase root not found: ${root}`);
  }
  return root;
}

function listDomainNames(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== RESOURCES_DIRECTORY)
    .map((entry) => entry.name)
    .sort(compareText);
}

function listEntryDirectories(domainRoot: string): string[] {
  return fs.readdirSync(domainRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => fs.existsSync(path.join(domainRoot, entry.name, ENTRY_FILE)))
    .map((entry) => entry.name)
    .sort(compareText);
}

/** Parse the level-1 index table: `- <domain>：<description>` lines. */
function readDomainIndex(root: string, warnings: string[]): KnowledgeBaseIndex {
  const descriptions = new Map<string, string>();
  const order: string[] = [];
  const indexFile = path.join(root, INDEX_FILE);
  if (!fs.existsSync(indexFile)) {
    warnings.push(`missing_index: ${INDEX_FILE} was not found under the knowledgebase root; every domain has an empty description.`);
    return { descriptions, order, warnings };
  }

  const lines = fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (!bullet) continue;
    const separated = splitIndexLine(bullet[1]);
    if (!separated) continue;
    if (descriptions.has(separated.name)) {
      warnings.push(`duplicate_index_domain: "${separated.name}" appears more than once in ${INDEX_FILE}; the first line is used.`);
      continue;
    }
    descriptions.set(separated.name, separated.description);
    order.push(separated.name);
  }
  return { descriptions, order, warnings };
}

function splitIndexLine(value: string): { name: string; description: string } | null {
  let separatorIndex = -1;
  for (const separator of ['：', ':']) {
    const index = value.indexOf(separator);
    if (index >= 0 && (separatorIndex < 0 || index < separatorIndex)) separatorIndex = index;
  }
  if (separatorIndex <= 0) return null;
  const name = value.slice(0, separatorIndex).trim();
  const description = value.slice(separatorIndex + 1).trim();
  return name ? { name, description } : null;
}

/** Read and validate one `<domain>/<entry>/skill.md`. */
function parseEntryFile(entryPath: string): ParsedEntry {
  const markdown = fs.readFileSync(path.join(entryPath, ENTRY_FILE), 'utf8').replace(/^\uFEFF/, '');
  const lines = markdown.split(/\r?\n/);
  if (!/^---[\t ]*$/.test(lines[0] || '')) {
    throw new Error(`${ENTRY_FILE} must begin with a YAML frontmatter delimiter (---).`);
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)[\t ]*$/.test(line));
  if (closingIndex < 0) throw new Error(`${ENTRY_FILE} frontmatter is missing its closing delimiter.`);

  const document = parseDocument(lines.slice(1, closingIndex).join('\n'), { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid YAML frontmatter: ${document.errors[0].message}`);
  const values = document.toJS();
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${ENTRY_FILE} frontmatter must be a YAML mapping.`);

  const metadata = values as Record<string, unknown>;
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (!name) throw new Error(`frontmatter requires a non-empty name (max ${MAX_NAME_CHARS} chars).`);
  if (name.length > MAX_NAME_CHARS) throw new Error(`frontmatter name is ${name.length} chars; the limit is ${MAX_NAME_CHARS}.`);
  if (!description) throw new Error('frontmatter requires a non-empty description.');
  const content = lines.slice(closingIndex + 1).join('\n').trim();
  if (!content) throw new Error('the knowledge body after the frontmatter is empty.');

  const warnings: string[] = [];
  if (description.length > ENTRY_DESCRIPTION_BUDGET_CHARS) {
    warnings.push(`description_exceeds_budget: "${name}" description is ${description.length} chars; keep it at or below ${ENTRY_DESCRIPTION_BUDGET_CHARS} chars so domain catalogs stay cheap to load.`);
  }
  if (content.length > ENTRY_BODY_BUDGET_CHARS) {
    warnings.push(`body_exceeds_budget: "${name}" body is ${content.length} chars; knowledgebase results are inlined up to 30000 chars, so longer bodies are truncated in context.`);
  }
  return { name, description, content, warnings };
}

/** Collect viewable resources; small text files are inlined, the rest is metadata only. */
function readEntryResources(root: string, entryPath: string, entryId: string): { resources: Record<string, unknown>[]; warnings: string[] } {
  const warnings: string[] = [];
  const resourcesDirectory = path.join(entryPath, RESOURCES_DIRECTORY);
  if (!fs.existsSync(resourcesDirectory)) return { resources: [], warnings };

  const files = walkFiles(resourcesDirectory).sort(compareText);
  const resources: Record<string, unknown>[] = [];
  let inlinedChars = 0;
  for (const file of files) {
    const relativePath = path.relative(root, file).replace(/\\/g, '/');
    const extension = path.extname(file).toLowerCase();
    const buffer = fs.readFileSync(file);
    const text = TEXT_EXTENSIONS.has(extension) ? buffer.toString('utf8') : null;
    if (EXECUTABLE_EXTENSIONS.has(extension)) {
      warnings.push(`executable_resource: "${relativePath}" looks executable; knowledgebase resources must be viewable material only.`);
    }
    const resource: Record<string, unknown> = {
      path: relativePath,
      mimeType: MIME_TYPES[extension] || (text === null ? 'application/octet-stream' : 'text/plain'),
      size: buffer.byteLength,
      encoding: text === null ? 'binary' : 'utf8',
    };
    if (text === null) {
      resource.note = 'Binary viewable resource; not inlined.';
    } else if (text.length <= INLINE_RESOURCE_CHARS && inlinedChars + text.length <= INLINE_RESOURCE_TOTAL_CHARS) {
      inlinedChars += text.length;
      resource.content = text;
    } else {
      resource.truncated = true;
      resource.note = `Resource is larger than the ${INLINE_RESOURCE_CHARS}-char inline limit; only metadata is shown.`;
    }
    resources.push(resource);
  }
  if (resources.length > MAX_RESOURCE_COUNT) warnings.push(`resource_count_exceeds_budget: "${entryId}" has ${resources.length} resources; consider splitting the entry.`);
  return { resources, warnings };
}

function walkFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(target);
    return entry.isFile() ? [target] : [];
  });
}

function normalizeEntryId(value: string): { id: string; domain: string; entry: string } | null {
  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.length !== 2) return null;
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  if (parts.some((part) => part.includes(':') || part.includes('\u0000'))) return null;
  return { id: `${parts[0]}/${parts[1]}`, domain: parts[0], entry: parts[1] };
}

function assertInside(root: string, target: string): void {
  const resolved = path.resolve(target);
  if (resolved !== path.resolve(root) && !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`Path escapes the knowledgebase root: ${target}`);
  }
}

function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS), `${warnings.length - MAX_WARNINGS} more warnings omitted.`];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
