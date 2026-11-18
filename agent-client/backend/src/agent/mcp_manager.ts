import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type {
  CatalogServerEntry,
  MCPConnectResult,
  MCPPrompt,
  MCPResource,
  MCPServerConfig,
  MCPTool,
} from './types.js';
import { interpolateEnvironment } from './config/secret_config.js';

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? {}, Object.keys((value ?? {}) as object).sort());
}

export { interpolateEnvironment } from './config/secret_config.js';

const MCP_CONNECT_TIMEOUT_MS = 15_000;

function interpolateEnvironmentRecord(values: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, interpolateEnvironment(value)]));
}

function contentToText(content: ContentBlock[] | undefined): string {
  const parts: string[] = [];
  for (const item of content ?? []) {
    if (item.type === 'text') {
      parts.push(item.text);
    } else if (item.type === 'image') {
      parts.push(`[image: ${item.mimeType}]`);
    } else if (item.type === 'audio') {
      parts.push(`[audio: ${item.mimeType}]`);
    } else if (item.type === 'resource') {
      if ('text' in item.resource) parts.push(item.resource.text);
      else parts.push(`[resource blob: ${item.resource.mimeType ?? 'application/octet-stream'}]`);
    } else if (item.type === 'resource_link') {
      parts.push(`[resource: ${item.uri}]`);
    }
  }
  return parts.join('\n');
}

function contentToJson(content: ContentBlock): Record<string, unknown> {
  if (content.type === 'text') return { type: 'text', text: content.text };
  if (content.type === 'image') return { type: 'image', mimeType: content.mimeType, data: content.data };
  if (content.type === 'audio') return { type: 'audio', mimeType: content.mimeType, data: content.data };
  if (content.type === 'resource') return { type: 'resource', resource: content.resource };
  return { type: 'resource_link', uri: content.uri, name: content.name, mimeType: content.mimeType };
}

export class MCPServerSession {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private tools: MCPTool[] | null = null;
  private prompts: MCPPrompt[] | null = null;
  private resources: MCPResource[] | null = null;
  private serverInstructions = '';

  connected = false;
  error?: string;

  constructor(
    readonly name: string,
    readonly config: MCPServerConfig,
  ) {}

  async start(timeoutMs = MCP_CONNECT_TIMEOUT_MS): Promise<void> {
    const transportType = this.config.transportType ?? 'stdio';
    try {
      this.transport = this.createTransport(transportType);
      this.client = new Client({ name: 'agent-client', version: '0.1.0' }, { capabilities: {} });
      await withTimeout(
        this.client.connect(this.transport),
        timeoutMs,
        `Connection to '${this.name}' timed out after ${timeoutMs / 1000}s`,
      );
      this.serverInstructions = this.client.getInstructions()?.trim() ?? '';
      this.connected = true;
      this.error = undefined;
    } catch (error) {
      this.connected = false;
      this.error = error instanceof Error ? error.message : String(error);
      await this.stop();
      throw error;
    }
  }

  private createTransport(transportType: MCPServerConfig['transportType']): Transport {
    if (transportType === 'stdio') {
      if (!this.config.command) throw new Error("stdio transport requires 'command'");
      return new StdioClientTransport({
        command: interpolateEnvironment(this.config.command),
        args: (this.config.args ?? []).map((arg) => interpolateEnvironment(arg)),
        env: { ...process.env, ...interpolateEnvironmentRecord(this.config.env) } as Record<string, string>,
      });
    }

    if (!this.config.url) throw new Error(`${transportType} transport requires 'url'`);
    const url = new URL(interpolateEnvironment(this.config.url));
    const headers = interpolateEnvironmentRecord(this.config.headers);

    if (transportType === 'sse') {
      return new SSEClientTransport(url, {
        eventSourceInit: { fetch: (input, init) => fetch(input, withHeaders(init, headers)) },
        requestInit: { headers },
      });
    }

    if (transportType === 'streamableHttp') {
      return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    }

    throw new Error(`Unsupported transport type: ${transportType}`);
  }

  async discoverTools(refresh = false): Promise<MCPTool[]> {
    if (this.tools && !refresh) return this.tools;
    if (!this.client) return [];
    const result = await this.client.listTools();
    this.tools = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    }));
    return this.tools;
  }

  async discoverPrompts(refresh = false): Promise<MCPPrompt[]> {
    if (this.prompts && !refresh) return this.prompts;
    if (!this.client) return [];
    try {
      const result = await this.client.listPrompts();
      this.prompts = result.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: (prompt.arguments ?? []).map((arg) => ({
          name: arg.name,
          description: arg.description,
          required: Boolean(arg.required),
        })),
      }));
    } catch {
      this.prompts = [];
    }
    return this.prompts;
  }

  async discoverResources(refresh = false): Promise<MCPResource[]> {
    if (this.resources && !refresh) return this.resources;
    if (!this.client) return [];
    try {
      const result = await this.client.listResources();
      this.resources = result.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    } catch {
      this.resources = [];
    }
    return this.resources;
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
    if (!this.client) throw new Error(`Server ${this.name} not initialized`);
    const result = await withTimeout(
      this.client.callTool({ name: toolName, arguments: args }) as Promise<CallToolResult>,
      timeoutMs,
      `Tool '${toolName}' timed out after ${timeoutMs / 1000}s on '${this.name}'`,
    );
    if ('content' in result) {
      const text = contentToText(result.content);
      if (result.isError) return `Error: tool '${toolName}' reported failure: ${text || 'unknown'}`;
      return text;
    }
    return JSON.stringify(result);
  }

  /** Server instructions captured from `initialize`; empty when the server sent none. */
  getInstructions(): string {
    return this.serverInstructions;
  }

  async readResource(uri: string): Promise<Record<string, unknown>> {
    if (!this.client) return { error: 'session not initialized' };
    try {
      return await this.client.readResource({ uri });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<Array<Record<string, unknown>>> {
    if (!this.client) return [];
    try {
      const result = await this.client.getPrompt({ name, arguments: args });
      return result.messages.map((message) => ({
        role: message.role,
        content: contentToJson(message.content),
      }));
    } catch (error) {
      return [{ role: 'error', content: { type: 'text', text: error instanceof Error ? error.message : String(error) } }];
    }
  }

  async stop(): Promise<void> {
    await this.transport?.close().catch(() => undefined);
    this.client = null;
    this.transport = null;
    this.connected = false;
    this.tools = null;
    this.prompts = null;
    this.resources = null;
    this.serverInstructions = '';
  }
}

export class MCPManager {
  private readonly sessions = new Map<string, MCPServerSession>();
  private readonly toolToServer = new Map<string, string>();
  private readonly publicToolToMcpTool = new Map<string, string>();

  async connectServers(configs: MCPServerConfig[]): Promise<MCPConnectResult> {
    const wanted = new Set(configs.map((c) => c.name).filter(Boolean));
    const disconnected: string[] = [];
    for (const name of [...this.sessions.keys()]) {
      if (!wanted.has(name)) {
        await this.disconnectServer(name);
        disconnected.push(name);
      }
    }

    const connected: MCPConnectResult['connected'] = [];
    const failed: MCPConnectResult['failed'] = [];
    const tools: ChatCompletionTool[] = [];
    const serverCatalog: MCPConnectResult['serverCatalog'] = [];

    for (const config of configs) {
      const name = config.name;
      const existing = this.sessions.get(name);
      if (existing?.connected) {
        if (configKey(existing.config) !== configKey(config)) {
          await this.disconnectServer(name);
        } else {
          await this.registerSessionCapabilities(existing, tools, serverCatalog, connected);
          continue;
        }
      }

      const session = new MCPServerSession(name, config);
      try {
        await session.start();
        this.sessions.set(name, session);
        await this.registerSessionCapabilities(session, tools, serverCatalog, connected);
      } catch (error) {
        failed.push({ name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { tools, serverCatalog, connected, failed, disconnected };
  }

  private async registerSessionCapabilities(
    session: MCPServerSession,
    openaiTools: ChatCompletionTool[],
    serverCatalog: MCPConnectResult['serverCatalog'],
    connected: MCPConnectResult['connected'],
  ): Promise<void> {
    this.removeToolRoutesForServer(session.name);
    const [tools, prompts, resources] = await Promise.all([
      session.discoverTools(),
      session.discoverPrompts(),
      session.discoverResources(),
    ]);
    const catalogTools: CatalogServerEntry['tools'] = [];
    for (const tool of tools) {
      const publicName = publicToolName(session.name, tool.name);
      const description = tool.description || `Tool from ${session.name}`;
      this.toolToServer.set(publicName, session.name);
      this.publicToolToMcpTool.set(publicName, tool.name);
      catalogTools.push({
        kind: 'mcp_tool',
        id: publicName,
        server: session.name,
        toolName: tool.name,
        description,
      });
      openaiTools.push({
        type: 'function',
        function: {
          name: publicName,
          description: `[${session.name}.${tool.name}] ${description}`,
          parameters: tool.inputSchema as any,
        },
      });
    }
    serverCatalog.push({
      name: session.name,
      instructions: session.getInstructions(),
      tools: catalogTools,
      resources: resources.map((resource) => ({
        kind: 'mcp_resource' as const,
        server: session.name,
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    });
    connected.push({
      name: session.name,
      tools_count: tools.length,
      prompts_count: prompts.length,
      resources_count: resources.length,
    });
  }

  async executeTool(publicToolName: string, args: Record<string, unknown>): Promise<string> {
    const serverName = this.toolToServer.get(publicToolName);
    const session = serverName ? this.sessions.get(serverName) : undefined;
    if (!session) return `Error: Tool '${publicToolName}' not found on any connected server`;
    return session.callTool(this.publicToolToMcpTool.get(publicToolName) ?? publicToolName, args);
  }

  /** Read one resource from a connected server; failures come back as `{ error }`. */
  async readResource(serverName: string, uri: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(serverName);
    if (!session) return { error: `Server '${serverName}' is not connected` };
    return session.readResource(uri);
  }

  getServer(name: string): MCPServerSession | undefined {
    return this.sessions.get(name);
  }

  async disconnectServer(name: string): Promise<boolean> {
    const session = this.sessions.get(name);
    if (!session) return false;
    await session.stop();
    this.sessions.delete(name);
    this.removeToolRoutesForServer(name);
    return true;
  }

  async cleanup(): Promise<void> {
    for (const name of [...this.sessions.keys()]) {
      await this.disconnectServer(name);
    }
  }

  private removeToolRoutesForServer(serverName: string): void {
    for (const [toolName, mappedServer] of [...this.toolToServer.entries()]) {
      if (mappedServer === serverName) {
        this.toolToServer.delete(toolName);
        this.publicToolToMcpTool.delete(toolName);
      }
    }
  }
}

function withHeaders(init: RequestInit | undefined, headers: Record<string, string>): RequestInit {
  return { ...init, headers: { ...(init?.headers ?? {}), ...headers } };
}

function configKey(config: MCPServerConfig): string {
  return [
    config.transportType ?? 'stdio',
    config.command ?? '',
    JSON.stringify(config.args ?? []),
    config.url ?? '',
    stableJson(config.env),
    stableJson(config.headers),
  ].join('|');
}

function publicToolName(serverName: string, toolName: string): string {
  const base = `${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'mcp_tool';
  if (base.length <= 64) return base;
  const digest = crypto.createHash('sha1').update(`${serverName}:${toolName}`).digest('hex').slice(0, 8);
  return `${base.slice(0, 55)}_${digest}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const mcpManager = new MCPManager();
