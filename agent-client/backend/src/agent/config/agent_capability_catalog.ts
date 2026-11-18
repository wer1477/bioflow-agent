import {
  readToolLibraryDomains,
  UNCLASSIFIED_DOMAIN_NAME,
} from '../core_tools/toollibrary_executor.js';
import {
  readKnowledgeBaseDomains,
  type StaticKnowledgeBaseDomain,
} from '../core_tools/knowledgebase_executor.js';
import { getAllMCPServers, type MCPServer } from './mcp_config_store.js';
import { getAllSkills, type Skill } from './skill_config_store.js';
import { KNOWLEDGEBASE_ROOT, TOOLLIBRARY_ROOT } from '../../paths.js';

/**
 * Read-only projections of the curated capability catalogs for the settings surface.
 *
 * Tool Library and Knowledge Base are two-level trees on disk. The runtime reconciles the
 * tool-library tree against the capabilities a single agent may load; the settings page
 * instead needs the complete curated view, plus enough configuration detail to know which
 * backing skill or MCP server each entry toggles.
 */

/** One tool-library catalog entry as shown on the Agent settings page. */
export interface ToolLibraryConfigEntry {
  kind: 'skill' | 'mcp';
  /** Skill id, or an MCP public tool name for catalog entries / a server id for the fallback domain. */
  id: string;
  name: string;
  description: string;
  /** The backing skill or MCP server still exists in configuration. */
  available: boolean;
  /** The backing skill or MCP server is enabled. */
  enabled: boolean;
  /** MCP only: configured server owning this public tool name (null when unmatched). */
  serverId?: string | null;
  serverName?: string | null;
}

export interface ToolLibraryConfigDomain {
  name: string;
  description: string;
  entries: ToolLibraryConfigEntry[];
}

export interface ToolLibraryConfigCatalog {
  domains: ToolLibraryConfigDomain[];
  warnings: string[];
}

export interface KnowledgeBaseConfigCatalog {
  domains: StaticKnowledgeBaseDomain[];
  warnings: string[];
}

type SkillSummary = Pick<Skill, 'id' | 'name' | 'description' | 'enabled'>;
type ServerSummary = Pick<MCPServer, 'id' | 'name' | 'description' | 'enabled'>;

interface CatalogOptions {
  /** Absolute tool-library root. Defaults to `agent-client/toollibrary`. */
  root?: string;
  skills?: SkillSummary[];
  servers?: ServerSummary[];
}

interface KnowledgeCatalogOptions {
  /** Absolute knowledgebase root. Defaults to `agent-client/knowledgebase`. */
  root?: string;
}

const UNCLASSIFIED_DESCRIPTION = 'Runtime fallback domain: capabilities that exist in configuration but are not listed in any curated domain file.';

/** Build the complete Tool Library view, grouped by curated domain. */
export function buildToolLibraryConfigCatalog(options: CatalogOptions = {}): ToolLibraryConfigCatalog {
  const root = options.root || TOOLLIBRARY_ROOT;
  const skills = options.skills ?? getAllSkills();
  const servers = options.servers ?? getAllMCPServers();
  const { domains, warnings } = readToolLibraryDomains(root);
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const listedSkillIds = new Set<string>();
  const listedServerIds = new Set<string>();

  const configDomains: ToolLibraryConfigDomain[] = domains.map((domain) => ({
    name: domain.name,
    description: domain.description,
    entries: domain.entries.map((entry) => {
      if (entry.kind === 'skill') {
        listedSkillIds.add(entry.id);
        const skill = skillById.get(entry.id);
        return {
          kind: 'skill' as const,
          id: entry.id,
          name: entry.name,
          description: entry.description,
          available: Boolean(skill),
          enabled: Boolean(skill?.enabled),
        };
      }
      const server = resolveMcpServer(entry.id, servers);
      if (server) listedServerIds.add(server.id);
      return {
        kind: 'mcp' as const,
        id: entry.id,
        name: entry.name,
        description: entry.description,
        available: Boolean(server),
        enabled: Boolean(server?.enabled),
        serverId: server?.id ?? null,
        serverName: server?.name ?? null,
      };
    }),
  }));

  // Every configured capability must stay reachable from the page, otherwise saving the
  // form would silently unbind whatever the catalog does not list (internal web-search
  // providers, disabled servers, or capabilities added before the catalog caught up).
  const fallbackSkills = skills.filter((skill) => !listedSkillIds.has(skill.id));
  const fallbackServers = servers.filter((server) => !listedServerIds.has(server.id));
  if (fallbackSkills.length || fallbackServers.length) {
    configDomains.push({
      name: UNCLASSIFIED_DOMAIN_NAME,
      description: UNCLASSIFIED_DESCRIPTION,
      entries: [
        ...fallbackSkills.map((skill) => ({
          kind: 'skill' as const,
          id: skill.id,
          name: skill.name,
          description: skill.description || 'No description',
          available: true,
          enabled: skill.enabled,
        })),
        ...fallbackServers.map((server) => ({
          kind: 'mcp' as const,
          id: server.id,
          name: server.name,
          description: server.description || 'No description',
          available: true,
          enabled: server.enabled,
          serverId: server.id,
          serverName: server.name,
        })),
      ],
    });
  }

  return { domains: configDomains, warnings };
}

/** Build the complete Knowledge Base view, grouped by curated domain. */
export function buildKnowledgeBaseConfigCatalog(options: KnowledgeCatalogOptions = {}): KnowledgeBaseConfigCatalog {
  try {
    return readKnowledgeBaseDomains({ root: options.root || KNOWLEDGEBASE_ROOT });
  } catch (error) {
    // A deployment without the curated tree must still render the settings page.
    return { domains: [], warnings: [`unreadable_root: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/**
 * Resolve the configured MCP server behind a public tool name.
 *
 * Public names are `sanitize(<server>__<tool>)` where repeated underscores collapse to
 * one, so the boundary is `sanitize(<server>) + '_'`. The longest match wins, which keeps
 * a server whose name is a prefix of another from stealing that server's tools.
 */
export function resolveMcpServer<T extends Pick<ServerSummary, 'id' | 'name'>>(publicToolName: string, servers: readonly T[]): T | null {
  let best: { server: T; prefixLength: number } | null = null;
  for (const server of servers) {
    for (const candidate of new Set([server.id, server.name].filter(Boolean))) {
      const prefix = publicToolPrefix(candidate);
      if (!prefix || !publicToolName.startsWith(prefix)) continue;
      if (!best || prefix.length > best.prefixLength) best = { server, prefixLength: prefix.length };
    }
  }
  return best?.server ?? null;
}

/** Mirror `mcpManager`'s public-name sanitizer for the `<server>__` prefix. */
export function publicToolPrefix(serverName: string): string {
  const base = `${serverName}__`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base ? `${base}_` : '';
}

