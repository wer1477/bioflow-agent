import fs from 'node:fs';
import path from 'node:path';
import { readConfig, writeConfig } from './file_config.js';
import { normalizeSecurityMode, type SecurityMode } from '../security_policy.js';
import { getRegisteredCoreTools } from '../core_tools_runtime.js';
import { isCapabilityCoreToolId } from '../core_tools/capability_selection.js';
import { listKnowledgeBaseEntryIds } from '../core_tools/knowledgebase_executor.js';
import { CONFIG_ROOT } from '../../paths.js';

/**
 * The fixed team roles, in the order the Web team switcher and the settings directory use.
 *
 * A role id *is* an agent id: the deployment runs exactly one team, so there is no second
 * dimension to keep in sync. Adding a role here is a schema change, not a data change.
 */
export const TEAM_ROLE_IDS = ['pi', 'searcher', 'researcher', 'writer', 'reviewer'] as const;
export type AgentRole = (typeof TEAM_ROLE_IDS)[number];
export type WorkspacePermission = 'none' | 'read' | 'write' | 'read_write';

/** `agents.json` on disk. Bumped when the `team` block was introduced. */
export const AGENTS_SCHEMA_VERSION = 2;

/**
 * How a user turn is routed to a role.
 *
 * `always-pi` is the only engine implemented today; the other two names are reserved so the
 * file records the intent and a later release can switch engines without a schema change.
 */
export type TeamRouterEngine = 'always-pi' | 'rules+llm' | 'biod';

export interface TeamConfig {
  /** Role that leads the team and may dispatch work to the others. */
  leadRoleId: AgentRole;
  /** Roles in display order; every entry must exist in `agents`. */
  roles: AgentRole[];
  router: {
    engine: TeamRouterEngine;
    /** Role a turn falls back to when routing cannot decide. */
    fallbackRoleId: AgentRole;
  };
  limits: {
    /** How many delegations may run at the same time. Never caps the total work. */
    maxConcurrentDispatches: number;
  };
}

/** One configurable CoreTool family, as exposed to the settings surface. */
export interface CoreTool {
  id: string;
  name: string;
  description: string;
  /**
   * Resident even when the agent does not bind it. True for the capability families: binding
   * them only routes selection to biod instead of degrading to the model.
   */
  alwaysAvailable?: boolean;
}

export interface AgentProfile {
  id: string;
  name: string;
  /** Short name shown in the team switcher and on message badges. */
  label: string;
  role: AgentRole;
  description: string;
  /**
   * One-line statement of when the lead should hand work to this role. Read by the
   * dispatcher and shown in the settings page; empty for the lead itself.
   */
  orchestratorDescription: string;
  systemPrompt: string;
  /**
   * Config-relative path of the file `systemPrompt` was read from. Kept on the profile so
   * the assembled prompt can name its own source in the transcript instead of the reader
   * having to guess which file produced it.
   */
  promptFile: string;
  llmProviderId: string | null;
  /**
   * Model inside `llmProviderId`. Absent means "the provider's default model", which is
   * what a provider-only binding meant before models were addressable.
   */
  llmModelId: string | null;
  /**
   * Level *name* from the model's `reasoningEfforts`, never the wire value. The wire
   * spelling differs per endpoint, so storing it here would pin one endpoint's dialect.
   */
  llmThinkingLevel: string | null;
  securityMode: SecurityMode;
  workspacePermission: WorkspacePermission;
  /**
   * Explicitly configured CoreTool ids. A legacy record without the field gets every
   * registered CoreTool so an existing deployment keeps working; an explicit `[]` means
   * the agent runs without CoreTools. New agents start empty.
   */
  coreToolIds: string[];
  /**
   * Knowledge-base entry ids (`<domain>/<entry>`) this agent may browse. An explicit `[]`
   * means no knowledge is reachable. A record without the field is migrated: an older
   * `knowledgeDomainIds` binding expands to the entries those domains contain today, and
   * a record with neither field gets every entry on disk.
   */
  knowledgeEntryIds: string[];
  mcpServerIds: string[];
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface AgentRecord {
  id: string;
  name: string;
  label: string;
  description: string;
  orchestratorDescription: string;
  promptFile: string;
  llmProviderId: string | null;
  llmModelId: string | null;
  llmThinkingLevel: string | null;
  securityMode: SecurityMode;
  coreToolIds: string[];
  knowledgeEntryIds: string[];
  mcpServerIds: string[];
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_TEAM: TeamConfig = {
  leadRoleId: 'pi',
  roles: [...TEAM_ROLE_IDS],
  router: { engine: 'always-pi', fallbackRoleId: 'pi' },
  limits: { maxConcurrentDispatches: 3 },
};

interface RoleDefaults {
  name: string;
  label: string;
  description: string;
  orchestratorDescription: string;
}

const ROLE_DEFAULTS: Record<AgentRole, RoleDefaults> = {
  pi: {
    name: 'PI',
    label: 'PI',
    description: '研究目标、任务分配、决策与成果验收',
    orchestratorDescription: '需要拆解目标、分派任务、仲裁分歧或验收成果时使用',
  },
  searcher: {
    name: '文献与假设专家',
    label: 'Searcher',
    description: '文献检索与证据综合、领域知识与研究现状、科学问题识别、假设生成与比较',
    orchestratorDescription: '需要查文献、梳理研究现状、提出或比较假设、初步判断创新性时使用',
  },
  researcher: {
    name: '研究执行专家',
    label: 'Researcher',
    description: '研究方案与实验设计、方法与计算方法选择、实验执行、数据处理与统计、结果解释',
    orchestratorDescription: '需要设计实验、跑分析、处理数据或解释结果时使用',
  },
  writer: {
    name: '论文写作专家',
    label: 'Writer',
    description: '论文框架与叙事逻辑、研究结果组织、图表与撰写、引用核验、投稿材料',
    orchestratorDescription: '需要把结果写成论文、组织图表或准备投稿材料时使用',
  },
  reviewer: {
    name: '审查专家',
    label: 'Reviewer',
    description: '科学问题与创新性、假设合理性、实验设计与方法学、数据与统计可靠性、结论一致性',
    orchestratorDescription: '需要挑毛病、评估证据强度或做投稿前审查时使用',
  },
};

const ROLE_IDS: readonly string[] = TEAM_ROLE_IDS;

function isTeamRole(id: string): id is AgentRole {
  return ROLE_IDS.includes(id);
}

function promptFileFor(role: AgentRole): string {
  return `prompts/${role}.md`;
}

/**
 * Create the five team roles when the deployment has no agents at all.
 *
 * A brand-new team starts with nothing configured: CoreTools, knowledge entries, skills and
 * MCP servers are explicit opt-ins from the settings page. The shipped `agents.json` in the
 * repository carries the curated bindings, so this path only runs for an empty config dir.
 */
export function ensureDefaultAgents(): void {
  if (readAgentRecords().length) return;
  const now = new Date().toISOString();
  writeAgentsConfig(TEAM_ROLE_IDS.map((role) => defaultRecord(role, now)), getTeamConfig());
}

/**
 * Bring `agents.json` to the five-role team schema.
 *
 * Idempotent and safe to run on every start: the file is only written when something
 * actually changed. Migration rules:
 * 1. the legacy single `main` agent becomes `pi` and keeps every capability binding;
 * 2. missing roles are filled in from `ROLE_DEFAULTS`, inheriting the lead's bindings;
 * 3. records that are not team roles are dropped (single-agent era leftovers).
 */
export function ensureTeamRoles(): void {
  const records = readAgentRecords();
  if (!records.length) {
    ensureDefaultAgents();
    return;
  }

  const now = new Date().toISOString();
  const byId = new Map<string, AgentRecord>();
  for (const record of records) byId.set(record.id, record);
  let changed = (readConfig('agents.json') as JsonRecord)?.schemaVersion !== AGENTS_SCHEMA_VERSION;

  const legacy = byId.get('main');
  if (legacy) {
    byId.delete('main');
    byId.set('pi', {
      ...legacy,
      id: 'pi',
      name: legacy.name === 'Main Agent' || !legacy.name ? ROLE_DEFAULTS.pi.name : legacy.name,
      label: ROLE_DEFAULTS.pi.label,
      description: legacy.description || ROLE_DEFAULTS.pi.description,
      orchestratorDescription: legacy.orchestratorDescription || ROLE_DEFAULTS.pi.orchestratorDescription,
      promptFile: migratePromptFile(legacy.promptFile, promptFileFor('pi')),
      updatedAt: now,
    });
    changed = true;
  }

  const team = getTeamConfig();
  const template = byId.get(team.leadRoleId) || records[0];
  for (const role of TEAM_ROLE_IDS) {
    if (byId.has(role)) continue;
    byId.set(role, defaultRecord(role, now, template));
    changed = true;
  }

  if (records.some((record) => !isTeamRole(record.id))) changed = true;
  if (!changed) return;
  writeAgentsConfig(TEAM_ROLE_IDS.map((role) => byId.get(role)!), team);
}

export function ensureCoreTools(): void {}

export function getAllCoreTools(): CoreTool[] {
  return getRegisteredCoreTools().map((definition) => ({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    ...(isCapabilityCoreToolId(definition.id) ? { alwaysAvailable: true } : {}),
  }));
}

export function getAllAgents(): AgentProfile[] {
  return readAgentRecords()
    .filter((record) => isTeamRole(record.id))
    .map(toProfile);
}

export function getAgent(id: string): AgentProfile | undefined {
  return getAllAgents().find((agent) => agent.id === id);
}

/** The role named by `team.leadRoleId`, falling back to the first configured role. */
export function getLeadAgent(): AgentProfile | undefined {
  const agents = getAllAgents();
  const team = getTeamConfig();
  return agents.find((agent) => agent.id === team.leadRoleId) || agents[0];
}

export function getTeamConfig(): TeamConfig {
  const raw = readConfig('agents.json') as JsonRecord | unknown[];
  const source = !Array.isArray(raw) && raw && typeof raw === 'object' ? (raw as JsonRecord).team : undefined;
  const team = source && typeof source === 'object' && !Array.isArray(source) ? (source as JsonRecord) : {};

  const leadRoleId = isTeamRole(String(team.leadRoleId)) ? (String(team.leadRoleId) as AgentRole) : DEFAULT_TEAM.leadRoleId;
  const roles = uniqueRoleIds(team.roles);
  const router = team.router && typeof team.router === 'object' && !Array.isArray(team.router) ? (team.router as JsonRecord) : {};
  const limits = team.limits && typeof team.limits === 'object' && !Array.isArray(team.limits) ? (team.limits as JsonRecord) : {};
  const engine = ['always-pi', 'rules+llm', 'biod'].includes(String(router.engine))
    ? (String(router.engine) as TeamRouterEngine)
    : DEFAULT_TEAM.router.engine;
  const fallbackRoleId = isTeamRole(String(router.fallbackRoleId))
    ? (String(router.fallbackRoleId) as AgentRole)
    : DEFAULT_TEAM.router.fallbackRoleId;
  const concurrency = Number(limits.maxConcurrentDispatches);

  return {
    leadRoleId,
    roles: roles.length ? roles : [...TEAM_ROLE_IDS],
    router: { engine, fallbackRoleId },
    limits: {
      maxConcurrentDispatches: Number.isInteger(concurrency) && concurrency > 0
        ? concurrency
        : DEFAULT_TEAM.limits.maxConcurrentDispatches,
    },
  };
}

export function updateTeamConfig(patch: Partial<TeamConfig> | Record<string, unknown>): TeamConfig {
  const current = getTeamConfig();
  const source = (patch || {}) as JsonRecord;
  const router = source.router && typeof source.router === 'object' ? (source.router as JsonRecord) : {};
  const limits = source.limits && typeof source.limits === 'object' ? (source.limits as JsonRecord) : {};
  const next: TeamConfig = {
    ...current,
    ...(isTeamRole(String(source.leadRoleId)) ? { leadRoleId: String(source.leadRoleId) as AgentRole } : {}),
    router: {
      engine: ['always-pi', 'rules+llm', 'biod'].includes(String(router.engine))
        ? (String(router.engine) as TeamRouterEngine)
        : current.router.engine,
      fallbackRoleId: isTeamRole(String(router.fallbackRoleId))
        ? (String(router.fallbackRoleId) as AgentRole)
        : current.router.fallbackRoleId,
    },
    limits: {
      maxConcurrentDispatches: Number.isInteger(Number(limits.maxConcurrentDispatches)) && Number(limits.maxConcurrentDispatches) > 0
        ? Number(limits.maxConcurrentDispatches)
        : current.limits.maxConcurrentDispatches,
    },
  };
  writeAgentsConfig(readAgentRecords().filter((record) => isTeamRole(record.id)), next);
  return next;
}

export function createAgent(data: Partial<AgentProfile>): AgentProfile {
  const id = String(data.id || '');
  if (!isTeamRole(id)) throw new Error(`Unknown team role: ${id || '(missing id)'}`);
  if (readAgentRecords().some((record) => record.id === id)) throw new Error(`The ${id} role already exists.`);
  const now = new Date().toISOString();
  const defaults = ROLE_DEFAULTS[id];
  const record: AgentRecord = {
    id,
    name: data.name || defaults.name,
    label: data.label || defaults.label,
    description: data.description || defaults.description,
    orchestratorDescription: data.orchestratorDescription || defaults.orchestratorDescription,
    promptFile: promptFileFor(id),
    llmProviderId: data.llmProviderId || null,
    llmModelId: data.llmModelId || null,
    llmThinkingLevel: data.llmThinkingLevel || null,
    securityMode: normalizeSecurityMode(data.securityMode),
    coreToolIds: unique(data.coreToolIds),
    knowledgeEntryIds: unique(data.knowledgeEntryIds),
    mcpServerIds: unique(data.mcpServerIds),
    skillIds: unique(data.skillIds),
    createdAt: now,
    updatedAt: now,
  };
  writePrompt(record.promptFile, data.systemPrompt || `You are ${record.name}.`);
  writeAgentsConfig([...readAgentRecords(), record], getTeamConfig());
  return toProfile(record);
}

export function updateAgent(id: string, data: Partial<AgentProfile>): AgentProfile | undefined {
  const records = readAgentRecords();
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) return undefined;
  const current = records[index];
  const next: AgentRecord = {
    ...current,
    name: data.name ?? current.name,
    label: data.label ?? current.label,
    description: data.description ?? current.description,
    orchestratorDescription: data.orchestratorDescription ?? current.orchestratorDescription,
    llmProviderId: data.llmProviderId ?? current.llmProviderId,
    llmModelId: data.llmModelId ?? current.llmModelId,
    llmThinkingLevel: data.llmThinkingLevel ?? current.llmThinkingLevel,
    securityMode: data.securityMode === undefined ? current.securityMode : normalizeSecurityMode(data.securityMode),
    coreToolIds: data.coreToolIds === undefined ? current.coreToolIds : unique(data.coreToolIds),
    knowledgeEntryIds: data.knowledgeEntryIds === undefined ? current.knowledgeEntryIds : unique(data.knowledgeEntryIds),
    mcpServerIds: data.mcpServerIds === undefined ? current.mcpServerIds : unique(data.mcpServerIds),
    skillIds: data.skillIds === undefined ? current.skillIds : unique(data.skillIds),
    updatedAt: new Date().toISOString(),
  };
  if (data.systemPrompt !== undefined) writePrompt(next.promptFile, data.systemPrompt);
  records[index] = next;
  writeAgentsConfig(records, getTeamConfig());
  return toProfile(next);
}

export function deleteAgent(_id: string): boolean { return false; }

/**
 * Freeze the role set.
 *
 * The team is a fixed five; nothing in the settings surface may add a sixth role or drop
 * one, because routing, prompts and the Web switcher all enumerate the same list.
 */
export function assertKnownRoles(ids: readonly string[]): AgentRole[] {
  return ids.map((id) => {
    if (!isTeamRole(id)) throw new Error(`Unknown team role: ${id}`);
    return id;
  });
}

/** How many roles still point at this provider. Deleting it is a decision, not a cleanup. */
export function countLLMProviderReferences(providerId: string): number {
  return readAgentRecords().filter((record) => record.llmProviderId === providerId).length;
}

export function removeLLMProviderReferences(providerId: string): boolean {
  return removeReference('llmProviderId', providerId, '');
}

export function removeMCPServerReferences(serverId: string): boolean {
  return removeReference('mcpServerIds', serverId);
}

export function removeSkillReferences(skillId: string): boolean {
  return removeReference('skillIds', skillId);
}

export function remapSkillReferences(replacements: ReadonlyMap<string, string>): boolean {
  if (!replacements.size) return false;
  const records = readAgentRecords();
  let changed = false;
  const next = records.map((record) => {
    const skillIds = unique(record.skillIds.map((id) => replacements.get(id) || id));
    if (skillIds.every((id, index) => id === record.skillIds[index]) && skillIds.length === record.skillIds.length) return record;
    changed = true;
    return { ...record, skillIds, updatedAt: new Date().toISOString() };
  });
  if (changed) writeAgentsConfig(next, getTeamConfig());
  return changed;
}

function readAgentRecords(): AgentRecord[] {
  return agentItems(readConfig('agents.json')).map(toRecord);
}

function agentItems(raw: unknown): JsonRecord[] {
  const container = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as JsonRecord) : {};
  const items: unknown[] = Array.isArray(raw) ? raw : Array.isArray(container.agents) ? container.agents as unknown[] : [];
  return items.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && Boolean((item as JsonRecord).id));
}

function toRecord(item: JsonRecord): AgentRecord {
  const id = String(item.id);
  return {
    id,
    name: String(item.name || id),
    label: String(item.label || (isTeamRole(id) ? ROLE_DEFAULTS[id].label : id)),
    description: String(item.description || ''),
    orchestratorDescription: String(item.orchestratorDescription || ''),
    promptFile: String(item.promptFile || item.prompt_file || promptFileFor(isTeamRole(id) ? id : 'pi')),
    llmProviderId: item.llmProviderId == null ? null : String(item.llmProviderId),
    llmModelId: item.llmModelId == null ? null : String(item.llmModelId),
    llmThinkingLevel: item.llmThinkingLevel == null ? null : String(item.llmThinkingLevel),
    securityMode: normalizeSecurityMode(item.securityMode),
    // Migration only: a record written before these fields existed keeps the behavior it
    // had at that time. Once the settings page saves, the list is persisted explicitly, so
    // "not configured" ([]) stays distinguishable from "never written" (field absent).
    coreToolIds: 'coreToolIds' in item ? unique(item.coreToolIds) : legacyCoreToolIds(),
    knowledgeEntryIds: 'knowledgeEntryIds' in item ? unique(item.knowledgeEntryIds) : legacyKnowledgeEntryIds(item.knowledgeDomainIds),
    mcpServerIds: unique(item.mcpServerIds),
    skillIds: unique(item.skillIds),
    createdAt: String(item.createdAt || ''),
    updatedAt: String(item.updatedAt || ''),
  };
}

function defaultRecord(role: AgentRole, now: string, template?: AgentRecord): AgentRecord {
  const defaults = ROLE_DEFAULTS[role];
  return {
    id: role,
    name: defaults.name,
    label: defaults.label,
    description: defaults.description,
    orchestratorDescription: defaults.orchestratorDescription,
    promptFile: promptFileFor(role),
    llmProviderId: template?.llmProviderId ?? null,
    llmModelId: template?.llmModelId ?? null,
    llmThinkingLevel: template?.llmThinkingLevel ?? null,
    securityMode: template?.securityMode ?? 'approval',
    coreToolIds: template ? [...template.coreToolIds] : [],
    knowledgeEntryIds: template ? [...template.knowledgeEntryIds] : [],
    mcpServerIds: template ? [...template.mcpServerIds] : [],
    skillIds: template ? [...template.skillIds] : [],
    createdAt: now,
    updatedAt: now,
  };
}

function writeAgentsConfig(records: AgentRecord[], team: TeamConfig): void {
  writeConfig('agents.json', {
    schemaVersion: AGENTS_SCHEMA_VERSION,
    team: {
      leadRoleId: team.leadRoleId,
      roles: [...team.roles],
      router: { ...team.router },
      limits: { ...team.limits },
    },
    agents: records.map((record) => ({
      id: record.id,
      name: record.name,
      label: record.label,
      description: record.description,
      orchestratorDescription: record.orchestratorDescription,
      promptFile: record.promptFile,
      llmProviderId: record.llmProviderId || '',
      ...(record.llmModelId ? { llmModelId: record.llmModelId } : {}),
      ...(record.llmThinkingLevel ? { llmThinkingLevel: record.llmThinkingLevel } : {}),
      securityMode: record.securityMode,
      coreToolIds: record.coreToolIds,
      knowledgeEntryIds: record.knowledgeEntryIds,
      mcpServerIds: record.mcpServerIds,
      skillIds: record.skillIds,
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    })),
  });
}

function toProfile(record: AgentRecord): AgentProfile {
  return {
    ...record,
    role: record.id as AgentRole,
    systemPrompt: readPrompt(record.promptFile),
    workspacePermission: 'read_write',
  };
}

/**
 * Point a migrated record at the renamed prompt file, copying the old content once.
 *
 * A deployment that never had `prompts/pi.md` must not end up with an empty system prompt,
 * so the legacy body is copied before the pointer moves.
 */
function migratePromptFile(from: string, to: string): string {
  const target = configPath(to);
  if (fs.existsSync(target)) return to;
  const source = configPath(from);
  if (!fs.existsSync(source)) return to;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return to;
  } catch {
    return from;
  }
}

function readPrompt(relativePath: string): string {
  const target = configPath(relativePath);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
}

function writePrompt(relativePath: string, content: string): void {
  const target = configPath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function configPath(relativePath: string): string {
  const root = path.resolve(process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Agent prompt path escapes configuration directory: ${relativePath}`);
  return target;
}

function unique(value: unknown): string[] { return [...new Set(Array.isArray(value) ? value.map(String).filter(Boolean) : [])]; }

function uniqueRoleIds(value: unknown): AgentRole[] {
  return unique(value).filter((id): id is AgentRole => isTeamRole(id));
}

function legacyCoreToolIds(): string[] {
  return getRegisteredCoreTools().map((definition) => definition.id);
}

/**
 * Expand a pre-entry-era binding into concrete entry ids.
 *
 * A missing or unreadable knowledgebase root must not make an old agent unloadable. The
 * domain list is the shape written by the previous release; a record that predates even
 * that field passes `undefined` and keeps every entry on disk.
 */
function legacyKnowledgeEntryIds(domains: unknown): string[] {
  try {
    const entries = listKnowledgeBaseEntryIds();
    if (domains === undefined) return entries;
    const names = new Set(unique(domains));
    return entries.filter((id) => names.has(id.slice(0, id.indexOf('/'))));
  } catch {
    return [];
  }
}

function removeReference(key: 'llmProviderId' | 'mcpServerIds' | 'skillIds', id: string, replacement?: string): boolean {
  const records = readAgentRecords();
  let changed = false;
  const next = records.map((record) => {
    if (key === 'llmProviderId' && record.llmProviderId === id) {
      changed = true;
      // The model and level only mean something relative to that provider, so they go
      // with it rather than dangling on whichever provider is picked next.
      return { ...record, llmProviderId: replacement || null, llmModelId: null, llmThinkingLevel: null, updatedAt: new Date().toISOString() };
    }
    if (key !== 'llmProviderId') {
      const values = record[key];
      const filtered = values.filter((value) => value !== id);
      if (filtered.length !== values.length) {
        changed = true;
        return { ...record, [key]: filtered, updatedAt: new Date().toISOString() };
      }
    }
    return record;
  });
  if (changed) writeAgentsConfig(next, getTeamConfig());
  return changed;
}
