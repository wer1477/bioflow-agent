import express from 'express';
import { loadBackendConfig } from '../../agent/config/backend_config_loader.js';
import {
  removeManagedLLMProviderModel,
  upsertManagedLLMProviderModels,
  countManagedLLMProviderReferences,
  createManagedLLMProvider,
  deleteManagedLLMProvider,
  deleteManagedMCPServer,
  importManagedMCPServers,
  removeManagedSkillReferences,
  updateManagedAgent,
  updateManagedLLMProvider,
  updateManagedTeam,
} from '../../agent/config/configuration_management_service.js';
import { getCatalogProvider, getCatalogGeneratedAt, listCatalogProviders } from '../../agent/config/llm_catalog.js';
import { getAllLLMProviders, getLLMProviderRecord, LLM_PROTOCOLS, type LLMProtocol } from '../../agent/config/llm_config_store.js';
import { interpolateEnvironment, isEnvironmentReference } from '../../agent/config/secret_config.js';
import { probeModels, verifyConnection } from '../../agent/llm_probe.js';
import {
  deleteSkill,
  getSkillDiagnostics,
  importSkillsFromDirectoryFiles,
  importSkillsFromZip,
  type SkillDirectoryImportFile,
} from '../../agent/config/skill_config_store.js';
import { maskMcpSecrets, maskProviderSecrets, readSettings } from './settings.js';

const router = express.Router();

type JsonRecord = Record<string, unknown>;

router.put('/agents/:id', (req, res) => {
  try {
    const agent = updateManagedAgent(req.params.id, managedAgentInput(req.body));
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    respondWithSettings(res, { changedFiles: ['agents.json', typeof req.body?.prompt === 'string' ? 'prompts/' : ''].filter(Boolean) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/agents/:id', (req, res) => {
  res.status(405).json({ error: 'Team roles cannot be deleted.' });
});

router.put('/team', (req, res) => {
  try {
    const team = updateManagedTeam(isRecord(req.body) ? req.body : {});
    respondWithSettings(res, { team, changedFiles: ['agents.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Provider presets from the bundled catalog. Read-only and unauthenticated like the rest of
 * the configuration surface; the payload is the same file that ships with the checkout.
 */
router.get('/llm/catalog', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ generatedAt: getCatalogGeneratedAt() || null, providers: listCatalogProviders(query) });
});

router.get('/llm/catalog/:presetId', (req, res) => {
  const provider = getCatalogProvider(req.params.presetId);
  if (!provider) {
    res.status(404).json({ error: 'Unknown catalog provider' });
    return;
  }
  res.json({ provider });
});

/** Asks an endpoint what it serves. Never writes: importing is a separate, explicit call. */
router.post('/llm/probe', async (req, res) => {
  try {
    const endpoint = resolveEndpointInput(req.body);
    const body = isRecord(req.body) ? req.body : {};
    const result = await probeModels(endpoint, {
      model: typeof body.model === 'string' ? body.model : undefined,
      probeThinkingLevels: body.probeThinkingLevels === true,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** One 1-token completion: proves URL, credential, model and thinking encoding agree. */
router.post('/llm/verify', async (req, res) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const endpoint = resolveEndpointInput(body);
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      res.status(400).json({ error: '缺少模型 ID。' });
      return;
    }
    const result = await verifyConnection({
      ...endpoint,
      model,
      ...(isRecord(body.thinking) && typeof body.thinking.format === 'string'
        ? { thinking: { format: body.thinking.format as 'openai-effort' | 'anthropic-budget' | 'none', wire: body.thinking.wire as string | number } }
        : {}),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/llm', (req, res) => {
  try {
    const provider = createManagedLLMProvider(managedLLMInput(req.body));
    respondWithSettings(res, { status: 201, provider: maskProviderSecrets([provider])[0], changedFiles: ['llm.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/llm/:id', (req, res) => {
  try {
    const provider = updateManagedLLMProvider(req.params.id, managedLLMInput(req.body, true));
    if (!provider) {
      res.status(404).json({ error: 'LLM provider not found' });
      return;
    }
    respondWithSettings(res, { provider: maskProviderSecrets([provider])[0], changedFiles: ['llm.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});


/**
 * Model rows are added through their own endpoint so the importer can refuse to overwrite a
 * hand-written row. The model id never appears in the path: ids such as
 * `RadixArk/Qwen3.8-Flash-Next-NVFP4` contain slashes and would not survive routing.
 */
router.post('/llm/:id/models', (req, res) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const entries = Array.isArray(body.models) ? body.models as Record<string, unknown>[] : [];
    if (!entries.length) {
      res.status(400).json({ error: '缺少要添加的模型。' });
      return;
    }
    const source = body.source === 'probe' || body.source === 'catalog' ? body.source : 'manual';
    const provider = upsertManagedLLMProviderModels(req.params.id, entries as never, source);
    if (!provider) {
      res.status(404).json({ error: 'LLM provider not found' });
      return;
    }
    respondWithSettings(res, { status: 201, provider: maskProviderSecrets([projectProvider(provider)])[0], changedFiles: ['llm.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/llm/:id/models/remove', (req, res) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
    if (!modelId) {
      res.status(400).json({ error: '缺少模型 ID。' });
      return;
    }
    const provider = removeManagedLLMProviderModel(req.params.id, modelId);
    if (!provider) {
      res.status(404).json({ error: 'LLM provider not found' });
      return;
    }
    respondWithSettings(res, { provider: maskProviderSecrets([projectProvider(provider)])[0], changedFiles: ['llm.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/llm/:id', (req, res) => {
  try {
    // A provider other roles still run on is not a leaf. Report the count and let the
    // caller decide, instead of silently repointing those roles at the default provider.
    const references = countManagedLLMProviderReferences(req.params.id);
    const force = req.query.force === '1' || req.query.force === 'true' || (isRecord(req.body) && req.body.force === true);
    if (references > 0 && !force) {
      res.status(409).json({
        error: `仍有 ${references} 个 Agent 绑定该 LLM 配置。确认删除后它们会失去模型绑定。`,
        references,
        providerId: req.params.id,
      });
      return;
    }
    const deleted = deleteManagedLLMProvider(req.params.id);
    if (!deleted) {
      respondWithSettings(res, { alreadyDeleted: true });
      return;
    }
    respondWithSettings(res, { changedFiles: ['llm.json', 'agents.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/mcp/import', (req, res) => {
  try {
    const servers = importManagedMCPServers(req.body?.content ?? req.body);
    respondWithSettings(res, { imported: servers.length, servers: maskMcpSecrets(servers), changedFiles: ['mcp.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/mcp/:id', (req, res) => {
  try {
    const deleted = deleteManagedMCPServer(req.params.id);
    if (!deleted) {
      respondWithSettings(res, { alreadyDeleted: true });
      return;
    }
    respondWithSettings(res, { changedFiles: ['mcp.json', 'agents.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/skills/import-zip', async (req, res) => {
  try {
    const skills = await importSkillsFromZip(String(req.body?.fileName || 'skill.zip'), String(req.body?.content || ''));
    respondWithSettings(res, { status: 201, skills, skillDiagnostics: getSkillDiagnostics(), changedFiles: skills.map((skill) => skill.id) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/skills/:id', (req, res) => {
  try {
    const deleted = deleteSkill(req.params.id);
    if (!deleted) {
      respondWithSettings(res, { alreadyDeleted: true });
      return;
    }
    removeManagedSkillReferences(req.params.id);
    respondWithSettings(res, { changedFiles: ['skills/', 'agents.json'] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/skills/import-files', (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files as SkillDirectoryImportFile[] : [];
    const skills = importSkillsFromDirectoryFiles(files);
    respondWithSettings(res, { status: 201, skills, skillDiagnostics: getSkillDiagnostics(), changedFiles: skills.map((skill) => skill.id) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function respondWithSettings(res: express.Response, extra: JsonRecord = {}): void {
  const reload = loadBackendConfig();
  const status = Number(extra.status || 200);
  const { status: _status, ...payload } = extra;
  res.status(status).json({
    ok: true,
    reload,
    settings: readSettings(),
    ...payload,
  });
}

function managedAgentInput(body: unknown): JsonRecord {
  const source = isRecord(body) ? body : {};
  const allowed = ['name', 'label', 'description', 'orchestratorDescription', 'llmProviderId', 'llmModelId', 'llmThinkingLevel', 'securityMode', 'coreToolIds', 'knowledgeEntryIds', 'mcpServerIds', 'skillIds', 'prompt'];
  return Object.fromEntries(allowed.filter((key) => key in source).map((key) => [key, source[key]]));
}

function managedLLMInput(body: unknown, isUpdate = false): JsonRecord {
  const source = isRecord(body) ? body : {};
  const data: JsonRecord = {};
  if ('baseUrl' in source || 'url' in source) data.baseUrl = source.baseUrl ?? source.url;
  if ('model' in source) data.model = source.model;
  if ('isDefault' in source) data.isDefault = source.isDefault;
  if ('contextWindowTokens' in source || 'context_window_tokens' in source) data.contextWindowTokens = source.contextWindowTokens ?? source.context_window_tokens;
  if ('thinkingLevel' in source || 'thinking_level' in source) data.thinkingLevel = source.thinkingLevel ?? source.thinking_level;
  if ('name' in source) data.name = source.name;
  if ('presetId' in source) data.presetId = source.presetId;
  if ('thinkingFormat' in source) data.thinkingFormat = source.thinkingFormat;
  if ('defaultModelId' in source) data.defaultModelId = source.defaultModelId;
  if ('models' in source) data.models = source.models;
  if ('headers' in source) data.headers = source.headers;
  if ('apiKey' in source && (!isUpdate || String(source.apiKey || '').trim())) data.apiKey = source.apiKey;
  return data;
}

/**
 * Probe inputs come either from the editor (plaintext key, never persisted) or from an
 * existing provider (an `${ENV}` reference that must resolve now).
 */
/**
 * The provider record as the editor consumes it. It is the flat projection plus the full
 * model list, because the editor manages rows that are not the default model.
 */
function projectProvider(record: { id: string }): { apiKey: string } & Record<string, unknown> {
  const stored = getLLMProviderRecord(record.id);
  const flat = getAllLLMProviders().find((provider) => provider.id === record.id);
  return { ...(flat || { apiKey: '' }), models: stored?.models || [] } as { apiKey: string } & Record<string, unknown>;
}

function resolveEndpointInput(body: unknown): { baseUrl: string; apiKey: string; headers?: Record<string, string>; protocol?: LLMProtocol } {
  const source = isRecord(body) ? body : {};
  const providerId = typeof source.providerId === 'string' ? source.providerId.trim() : '';
  const stored = providerId ? getLLMProviderRecord(providerId) : undefined;
  const baseUrl = typeof source.baseUrl === 'string' && source.baseUrl.trim() ? source.baseUrl.trim() : stored?.baseUrl || '';
  if (!baseUrl) throw new Error('缺少 Base URL。');
  const rawKey = typeof source.apiKey === 'string' && source.apiKey.trim() ? source.apiKey.trim() : stored?.apiKey || '';
  const apiKey = isEnvironmentReference(rawKey) ? interpolateEnvironment(rawKey, process.env, 'LLM probe') : rawKey;
  // A probe of an existing provider must carry the same required headers the runtime
  // sends (OpenCode rejects a completion without its routing header).
  const rawHeaders = isRecord(source.headers) ? source.headers : stored?.headers;
  const headers = rawHeaders
    ? Object.fromEntries(
      Object.entries(rawHeaders)
        .filter(([, value]) => typeof value === 'string')
        .map(([name, value]) => [name, interpolateEnvironment(value as string, process.env, 'LLM probe')]),
    )
    : undefined;
  // A probe must speak the same protocol the runtime will: an Anthropic provider probed
  // through `/chat/completions` reports a 404 that looks like a broken base URL.
  const protocol = (typeof source.protocol === 'string' && (LLM_PROTOCOLS as readonly string[]).includes(source.protocol)
    ? source.protocol
    : stored?.protocol) as LLMProtocol | undefined;
  return { baseUrl, apiKey, ...(headers && Object.keys(headers).length ? { headers } : {}), ...(protocol ? { protocol } : {}) };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDirectoryName(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export default router;
