import express from 'express';
import { getAllAgents, getAllCoreTools, getTeamConfig, type AgentProfile } from '../../agent/config/agent_config_store.js';
import { buildCoreToolsForIds, getCoreToolCatalog } from '../../agent/core_tools_runtime.js';
import { getAllLLMProviders, getLLMModelOptions } from '../../agent/config/llm_config_store.js';
import { getAllMCPServers } from '../../agent/config/mcp_config_store.js';
import { getAllSystemPrompts } from '../../agent/config/prompt_config_store.js';
import { getAllSkills, getSkillDiagnostics, reloadSkillCache } from '../../agent/config/skill_config_store.js';
import { loadBackendConfig } from '../../agent/config/backend_config_loader.js';
import { buildKnowledgeBaseConfigCatalog, buildToolLibraryConfigCatalog } from '../../agent/config/agent_capability_catalog.js';
import { isSecretKey, maskSecret } from '../../agent/config/secret_config.js';
import { isAuthEnabled } from '../../auth/config.js';

const router = express.Router();

router.get('/', (req, res) => {
  loadBackendConfig();
  res.json(settingsForRequest(readSettings(), isAuthEnabled() ? req.authUser : undefined));
});

/**
 * 登录版里普通用户不该拿到系统提示词：设置页对用户是只读的，提示词也不在
 * 他们的编辑范围内。管理员与开发实例保持完整载荷。
 */
export function settingsForRequest<T extends { agents: Array<Record<string, unknown>>; prompts: unknown }>(
  payload: T,
  user: { role?: string } | undefined,
): T {
  if (!isAuthEnabled() || user?.role === 'admin') return payload;
  return {
    ...payload,
    prompts: [] as unknown as T['prompts'],
    agents: payload.agents.map((agent) => {
      const { systemPrompt: _systemPrompt, ...rest } = agent;
      return rest;
    }) as T['agents'],
  };
}

router.post('/reload', (_req, res) => {
  const result = loadBackendConfig();
  reloadSkillCache();
  res.json({ result, settings: readSettings() });
});

export function readSettings() {
  const skills = getSkillSummaries();
  return {
    agents: getAllAgents().map(stripLegacyAgentFields),
    team: getTeamConfig(),
    llmProviders: maskProviderSecrets(getAllLLMProviders()),
    // The role editor picks a provider, then a model of it, then a level of that model.
    llmModels: getLLMModelOptions(),
    prompts: getAllSystemPrompts(),
    coreTools: getCoreToolSummaries(),
    mcpServers: maskMcpSecrets(getAllMCPServers()),
    skills,
    skillDiagnostics: getSkillDiagnostics(),
    toolLibrary: buildToolLibraryConfigCatalog(),
    knowledgeBase: buildKnowledgeBaseConfigCatalog(),
  };
}

function getCoreToolSummaries() {
  return getAllCoreTools().map((tool) => {
    const catalog = getCoreToolCatalog([tool.id])[0];
    return {
      ...tool,
      progressiveDescription: [
        catalog ? formatCoreToolCatalogDescription(catalog) : '该 CoreTool 会在配置后默认加载。',
        ...(tool.alwaysAvailable
          ? ['该 CoreTool 始终注入角色上下文：勾选时默认交给 biod 决策，未勾选时退化为模型自行浏览选择。']
          : []),
      ].join('\n'),
      fullLoadDescription: formatCoreToolFullDescription(tool.id),
    };
  });
}

function formatCoreToolCatalogDescription(catalog: { id: string; name: string; description: string }): string {
  return [
    'Configured CoreTools are loaded before the first model turn.',
    `- ${catalog.name} (${catalog.id}): ${catalog.description}`,
  ].join('\n');
}

function formatCoreToolFullDescription(coreToolId: string): string {
  const schemas = buildCoreToolsForIds([coreToolId]);
  if (schemas.length) {
    return JSON.stringify(schemas.map((schema) => schema.type === 'function' ? schema.function : schema), null, 2);
  }
  return '该 CoreTool 没有可直接展开的完整 tool schema。';
}

function stripLegacyAgentFields(agent: AgentProfile): Omit<AgentProfile, 'workspacePermission'> {
  const { workspacePermission: _workspacePermission, ...rest } = agent;
  return rest;
}

function getSkillSummaries() {
  return getAllSkills().map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description || '',
    enabled: skill.enabled,
    promptId: skill.promptId || null,
    isBuiltin: skill.isBuiltin,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }));
}

export function maskProviderSecrets<T extends { apiKey: string; headers?: Record<string, string> }>(providers: T[]): T[] {
  return providers.map((provider) => ({
    ...provider,
    apiKey: maskSecret(provider.apiKey),
    // Header values follow the same rule as MCP: only names that look secret are
    // masked, so a routing header (x-opencode-session) stays readable.
    ...(provider.headers ? { headers: maskRecord(provider.headers) } : {}),
  }));
}

export function maskMcpSecrets<T extends { env: Record<string, string>; headers: Record<string, string> }>(servers: T[]): T[] {
  return servers.map((server) => ({
    ...server,
    env: maskRecord(server.env),
    headers: maskRecord(server.headers),
  }));
}

function maskRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record || {}).map(([key, value]) => [
    key,
    isSecretKey(key) ? maskSecret(value) : value,
  ]));
}

export default router;
