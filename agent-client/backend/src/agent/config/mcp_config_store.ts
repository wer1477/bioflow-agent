import { v4 as uuidv4 } from 'uuid';
import { readConfig, writeConfig } from './file_config.js';
import { mcpCredentialEnvironmentName, persistEnvironmentSecret } from './environment_file_store.js';
import { assertSecretReferences, isEnvironmentReference, isSecretKey } from './secret_config.js';

type JsonRecord = Record<string, unknown>;
type MCPTransportType = 'stdio' | 'sse' | 'streamableHttp';

export interface MCPServer {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  transportType: MCPTransportType;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  /**
   * Runtime-internal server: it only backs a built-in runtime tool (currently the
   * `web_search` providers Tavily/Exa) and keeps its own tools and resources out
   * of the tool library. Defaults to false when the config omits the field.
   */
  internal: boolean;
  createdAt: string;
  updatedAt: string;
}

export function getAllMCPServers(): MCPServer[] {
  return all();
}

export function getMCPServer(id: string): MCPServer | undefined {
  return all().find((server) => server.id === id);
}

export function createMCPServer(data: Omit<MCPServer, 'id' | 'createdAt' | 'updatedAt'>): MCPServer {
  const now = new Date().toISOString();
  const item = prepareMcpSecrets(canonicalServer({ ...data, id: uuidv4(), createdAt: now, updatedAt: now }));
  assertValidServer(item);
  const items = all();
  items.push(item);
  save(items);
  return item;
}

export function updateMCPServer(id: string, data: Partial<MCPServer>): MCPServer | undefined {
  const items = all();
  const index = items.findIndex((server) => server.id === id);
  if (index < 0) return undefined;
  const item = prepareMcpSecrets(canonicalServer({ ...items[index], ...data, id, updatedAt: new Date().toISOString() }));
  assertValidServer(item);
  items[index] = item;
  save(items);
  return item;
}

export function deleteMCPServer(id: string): boolean {
  const items = all();
  const next = items.filter((server) => server.id !== id);
  if (next.length === items.length) return false;
  save(next);
  return true;
}

export function replaceMCPServers(values: unknown[]): void {
  const servers = values.map((value) => prepareMcpSecrets(canonicalServer(value)));
  servers.forEach(assertValidServer);
  save(servers);
}

/** Accepts the common MCP import formats and persists only the canonical schema. */
export function importMCPServers(raw: unknown): MCPServer[] {
  const imported = parseMCPImport(raw);
  const existing = all().map(prepareMcpSecrets);
  const existingById = new Map(existing.map((server) => [server.id, server]));
  const now = new Date().toISOString();
  const updates = imported.map((server) => {
    const previous = existingById.get(server.id);
    return prepareMcpSecrets(canonicalServer({
      ...server,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    }));
  });
  updates.forEach(assertValidServer);
  const importedById = new Map(updates.map((server) => [server.id, server]));
  save([...existing.filter((server) => !importedById.has(server.id)), ...updates]);
  return updates;
}

function all(): MCPServer[] {
  const raw = readConfig('mcp.json');
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : [];
  return items.filter(isRecord).map(canonicalServer);
}

function save(items: MCPServer[]): void {
  writeConfig('mcp.json', { servers: items.map(canonicalServer) });
}

function parseMCPImport(raw: unknown): MCPServer[] {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && isRecord(parsed.mcpServers)
      ? Object.entries(parsed.mcpServers).map(([name, value]) => ({ name, ...(isRecord(value) ? value : {}) }))
      : isRecord(parsed) && Array.isArray(parsed.servers)
        ? parsed.servers
        : isRecord(parsed)
          ? [parsed]
          : [];
  return entries.map((entry) => {
    const server = canonicalServer(entry);
    if (!server.name) throw new Error('MCP server requires a name.');
    return server;
  });
}

function canonicalServer(value: unknown): MCPServer {
  const raw = isRecord(value) ? value : {};
  const name = stringValue(raw.name ?? raw.id).trim();
  const transportType = normalizeTransportType(raw.transportType ?? raw.transport_type ?? (raw.url ? 'sse' : 'stdio'));
  return {
    id: stringValue(raw.id || name),
    name,
    description: stringValue(raw.description),
    command: stringValue(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map(stringValue) : [],
    env: stringRecord(raw.env),
    transportType,
    url: stringValue(raw.url),
    headers: stringRecord(raw.headers),
    enabled: raw.enabled !== false,
    internal: raw.internal === true,
    createdAt: stringValue(raw.createdAt),
    updatedAt: stringValue(raw.updatedAt),
  };
}

function assertValidServer(server: MCPServer): void {
  if (!server.id || !server.name) throw new Error('MCP server requires an id and name.');
  assertSecretReferences(server, 'MCP configuration');
}

/**
 * Accept literal credentials at a write boundary, then retain only an
 * environment-variable reference in the shared configuration file.
 */
function prepareMcpSecrets(server: MCPServer): MCPServer {
  return {
    ...server,
    env: prepareSecretRecord(server.id, server.env),
    headers: prepareSecretRecord(server.id, server.headers),
  };
}

function prepareSecretRecord(serverId: string, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (!isSecretKey(key) || !value.trim() || isEnvironmentReference(value)) return [key, value];
    const variableName = mcpCredentialEnvironmentName(serverId, key);
    persistEnvironmentSecret(variableName, value);
    return [key, '${' + variableName + '}'];
  }));
}

function normalizeTransportType(value: unknown): MCPTransportType {
  const transportType = stringValue(value);
  if (transportType === 'stdio' || transportType === 'sse' || transportType === 'streamableHttp') return transportType;
  throw new Error(`Unsupported MCP transport type: ${transportType}`);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stringValue(item)]));
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}
