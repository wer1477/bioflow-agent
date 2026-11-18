import {
  countLLMProviderReferences,
  removeLLMProviderReferences,
  removeMCPServerReferences,
  removeSkillReferences,
  updateAgent,
  updateTeamConfig,
  type AgentProfile,
  type TeamConfig,
} from './agent_config_store.js';
import {
  createLLMProvider,
  deleteLLMProvider,
  removeProviderModel,
  updateLLMProvider,
  upsertProviderModels,
  type LLMModelEntry,
  type LLMProvider,
  type LLMProviderInput,
  type LLMProviderRecord,
  type ModelMetadataSource,
} from './llm_config_store.js';
import { v4 as uuidv4 } from 'uuid';
import { environmentReference, llmApiKeyEnvironmentName, persistEnvironmentSecret } from './environment_file_store.js';
import { isEnvironmentReference } from './secret_config.js';
import {
  deleteMCPServer,
  importMCPServers,
  type MCPServer,
} from './mcp_config_store.js';

/**
 * Write-side façade for the configuration-management HTTP API.
 * Stores own serialization and normalization; this layer only coordinates
 * references spanning more than one configuration file.
 */
export function updateManagedAgent(id: string, data: Record<string, unknown>): AgentProfile | undefined {
  const { prompt, ...profile } = data;
  return updateAgent(id, {
    ...profile,
    ...(typeof prompt === 'string' ? { systemPrompt: prompt } : {}),
  } as Partial<AgentProfile>);
}

/**
 * Team-level policy. Role membership is fixed, so only routing and concurrency are writable
 * here; `roles` and the agent records themselves go through the per-role endpoint.
 */
export function updateManagedTeam(data: Record<string, unknown>): TeamConfig {
  const router = isRecord(data.router) ? data.router : {};
  const limits = isRecord(data.limits) ? data.limits : {};
  const maxConcurrent = Number(limits.maxConcurrentDispatches);
  const patch: Record<string, unknown> = {
    router: {
      ...(typeof router.engine === 'string' ? { engine: router.engine } : {}),
      ...(typeof router.fallbackRoleId === 'string' ? { fallbackRoleId: router.fallbackRoleId } : {}),
    },
  };
  if (typeof data.leadRoleId === 'string') patch.leadRoleId = data.leadRoleId;
  if (Number.isInteger(maxConcurrent) && maxConcurrent > 0) patch.limits = { maxConcurrentDispatches: maxConcurrent };
  return updateTeamConfig(patch);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createManagedLLMProvider(data: Record<string, unknown>): LLMProvider {
  const id = uuidv4();
  return createLLMProvider({ ...prepareLLMApiKey(data, id), id } as LLMProviderInput);
}

export function updateManagedLLMProvider(id: string, data: Record<string, unknown>): LLMProvider | undefined {
  return updateLLMProvider(id, prepareLLMApiKey(data, id) as LLMProviderInput);
}

/** Adds or imports model rows. `source` decides whether a later import may overwrite them. */
export function upsertManagedLLMProviderModels(id: string, entries: LLMModelEntry[], source: ModelMetadataSource): LLMProviderRecord | undefined {
  return upsertProviderModels(id, entries, source);
}

export function removeManagedLLMProviderModel(id: string, modelId: string): LLMProviderRecord | undefined {
  return removeProviderModel(id, modelId);
}

export function countManagedLLMProviderReferences(id: string): number {
  return countLLMProviderReferences(id);
}

export function deleteManagedLLMProvider(id: string): boolean {
  const deleted = deleteLLMProvider(id);
  removeLLMProviderReferences(id);
  return deleted;
}

export function importManagedMCPServers(raw: unknown): MCPServer[] {
  return importMCPServers(raw);
}

export function deleteManagedMCPServer(id: string): boolean {
  const deleted = deleteMCPServer(id);
  removeMCPServerReferences(id);
  return deleted;
}

export function removeManagedSkillReferences(id: string): boolean {
  return removeSkillReferences(id);
}

function prepareLLMApiKey(data: Record<string, unknown>, providerId: string): Record<string, unknown> {
  if (!('apiKey' in data)) return data;
  const apiKey = String(data.apiKey || '').trim();
  if (!apiKey || isEnvironmentReference(apiKey)) return { ...data, apiKey };
  const name = llmApiKeyEnvironmentName(providerId);
  persistEnvironmentSecret(name, apiKey);
  return { ...data, apiKey: environmentReference(name) };
}
