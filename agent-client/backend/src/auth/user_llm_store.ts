import crypto from 'node:crypto';
import type { SqlDatabase } from './db.js';
import { getAuthModule } from './runtime.js';
import { currentWorkspaceScope } from '../workspace_scope.js';
import { AuthError } from './errors.js';
import { decryptSecret, encryptSecret } from './secret_box.js';
import { TEAM_ROLE_IDS } from '../agent/config/agent_config_store.js';
import {
  getLLMProviderDocument,
  resolveLLMTarget as resolveGlobalLLMTarget,
  resolveLLMTargetFromRecords,
  type LLMModelEntry,
  type LLMProviderRecord,
  type LLMTargetResolution,
  type LLMProtocol,
  type ThinkingFormat,
  LLM_PROTOCOLS,
} from '../agent/config/llm_config_store.js';
import { maskSecret } from '../agent/config/secret_config.js';

/**
 * 每用户 LLM provider 与「角色 → provider」绑定。
 *
 * - 系统预置（`llm.json`，当前只有 DGX）对所有用户只读可见；用户自己的 provider
 *   存在鉴权 SQLite 里，API key 用 AES-256-GCM 加密，管理员也看不到明文。
 * - 解析顺序（在 agent_context_resolver 里拼装）：run 覆盖 > 用户角色绑定 >
 *   agents.json 角色绑定 > llm.json 默认。
 * - 所有函数都以当前 workspace 作用域的用户为准；没有作用域（开发实例/测试）时
 *   解析回退到全局配置。
 */

export interface UserLLMProviderView {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  thinkingFormat: ThinkingFormat;
  protocol: LLMProtocol;
  defaultModelId?: string;
  models: LLMModelEntry[];
  presetId?: string;
  createdAt: string;
  updatedAt: string;
  readOnly?: boolean;
}

export interface UserRoleBindingView {
  roleId: string;
  providerId: string;
  modelId?: string;
  thinkingLevel?: string;
  updatedAt: string;
}

export interface UserLLMSettings {
  providers: UserLLMProviderView[];
  systemProviders: UserLLMProviderView[];
  roleBindings: UserRoleBindingView[];
  modelOptions: Record<string, Array<{
    id: string;
    label: string;
    contextWindowTokens?: number;
    thinkingLevels?: string[];
    capabilities?: { tools?: boolean; images?: boolean };
  }>>;
  roles: string[];
}

interface ProviderRow {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  thinking_format: string;
  protocol: string | null;
  default_model_id: string | null;
  models_json: string;
  api_key_ciphertext: string;
  preset_id: string | null;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  role_id: string;
  provider_id: string;
  model_id: string | null;
  thinking_level: string | null;
  updated_at: string;
}

const MAX_MODELS = 50;
const THINKING_FORMATS = new Set<ThinkingFormat>(['openai-effort', 'anthropic-budget', 'none']);

function requireContext(): { db: SqlDatabase; secretKey: Buffer; userId: string } {
  const module = getAuthModule();
  if (!module?.enabled || !module.database || !module.secretKey) {
    throw new AuthError(503, '登录鉴权未启用。');
  }
  const scope = currentWorkspaceScope();
  if (!scope) throw new AuthError(401, '未登录或登录已过期。');
  return { db: module.database, secretKey: module.secretKey, userId: scope.userId };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > maxLength) throw new AuthError(400, `字段长度不能超过 ${maxLength} 个字符。`);
  return text;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const text = optionalText(value, maxLength);
  if (!text) throw new AuthError(400, `缺少${label}。`);
  return text;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeBaseUrl(value: unknown): string {
  const raw = requiredText(value, ' Base URL', 2000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthError(400, 'Base URL 格式不正确。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AuthError(400, 'Base URL 只支持 http/https。');
  }
  return raw.replace(/\/+$/, '');
}

function normalizeProtocol(value: unknown): LLMProtocol {
  const raw = optionalText(value, 40);
  if (!raw) return 'openai-completions';
  if (!(LLM_PROTOCOLS as readonly string[]).includes(raw)) throw new AuthError(400, '协议不正确。');
  return raw as LLMProtocol;
}

function normalizeThinkingFormat(value: unknown): ThinkingFormat {
  const raw = optionalText(value, 40);
  if (!raw) return 'none';
  if (!THINKING_FORMATS.has(raw as ThinkingFormat)) throw new AuthError(400, '思考格式不正确。');
  return raw as ThinkingFormat;
}

function normalizeModels(value: unknown): LLMModelEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new AuthError(400, '至少配置一个模型。');
  if (value.length > MAX_MODELS) throw new AuthError(400, `模型数量不能超过 ${MAX_MODELS} 个。`);
  const seen = new Set<string>();
  return value.map((item) => {
    const source = asRecord(item);
    const id = requiredText(source.id, '模型 id', 200);
    if (seen.has(id)) throw new AuthError(400, `模型 id 重复：${id}`);
    seen.add(id);
    const model: LLMModelEntry = { id };
    const label = optionalText(source.label, 200);
    if (label) model.label = label;
    const contextWindowTokens = positiveInteger(source.contextWindowTokens);
    if (contextWindowTokens) model.contextWindowTokens = contextWindowTokens;
    const maxOutputTokens = positiveInteger(source.maxOutputTokens);
    if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens;
    if (source.reasoningEfforts !== undefined) {
      const attempts = asRecord(source.reasoningEfforts);
      const efforts: Record<string, string | number> = {};
      for (const [level, wire] of Object.entries(attempts)) {
        if (typeof wire !== 'string' && typeof wire !== 'number') {
          throw new AuthError(400, `思考档位 ${level} 的值必须是字符串或数字。`);
        }
        efforts[level] = wire;
      }
      if (Object.keys(efforts).length) model.reasoningEfforts = efforts;
    }
    const defaultThinkingLevel = optionalText(source.defaultThinkingLevel, 100);
    if (defaultThinkingLevel) {
      if (!model.reasoningEfforts?.[defaultThinkingLevel]) {
        throw new AuthError(400, `默认思考档位 ${defaultThinkingLevel} 未在 reasoningEfforts 中声明。`);
      }
      model.defaultThinkingLevel = defaultThinkingLevel;
    }
    if (source.capabilities !== undefined) {
      const capabilities = asRecord(source.capabilities);
      model.capabilities = {
        ...(typeof capabilities.tools === 'boolean' ? { tools: capabilities.tools } : {}),
        ...(typeof capabilities.images === 'boolean' ? { images: capabilities.images } : {}),
      };
    }
    if (source.metadataSource === 'catalog' || source.metadataSource === 'probe' || source.metadataSource === 'manual') {
      model.metadataSource = source.metadataSource;
    }
    return model;
  });
}

interface NormalizedProviderInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  thinkingFormat: ThinkingFormat;
  protocol: LLMProtocol;
  defaultModelId?: string;
  models: LLMModelEntry[];
  presetId?: string;
}

function normalizeProviderInput(value: unknown, options: { requireKey: boolean }): NormalizedProviderInput {
  const source = asRecord(value);
  const name = requiredText(source.name, '提供商名称', 80);
  const baseUrl = normalizeBaseUrl(source.baseUrl);
  const apiKey = optionalText(source.apiKey, 4000);
  if (options.requireKey && !apiKey) throw new AuthError(400, '缺少 API Key。');
  const models = normalizeModels(source.models);
  const requestedDefault = optionalText(source.defaultModelId, 200);
  const defaultModelId = requestedDefault || models[0].id;
  if (!models.some((model) => model.id === defaultModelId)) {
    throw new AuthError(400, `默认模型 ${defaultModelId} 不在模型列表中。`);
  }
  return {
    name,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    thinkingFormat: normalizeThinkingFormat(source.thinkingFormat),
    protocol: normalizeProtocol(source.protocol),
    defaultModelId,
    models,
    presetId: optionalText(source.presetId, 200) || undefined,
  };
}

function readUserRows(db: SqlDatabase, userId: string): ProviderRow[] {
  return db
    .prepare('SELECT * FROM user_llm_providers WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId) as ProviderRow[];
}

function requireRow(db: SqlDatabase, userId: string, id: string): ProviderRow {
  const row = db
    .prepare('SELECT * FROM user_llm_providers WHERE user_id = ? AND id = ?')
    .get(userId, id) as ProviderRow | undefined;
  if (!row) throw new AuthError(404, '提供商不存在。');
  return row;
}

function rowToRecord(row: ProviderRow, secretKey: Buffer): LLMProviderRecord {
  let apiKey = '';
  try {
    apiKey = decryptSecret(secretKey, row.api_key_ciphertext);
  } catch {
    throw new AuthError(500, '无法解密该提供商的 API Key（主密钥可能已更换）。');
  }
  return {
    id: row.id,
    presetId: row.preset_id ?? undefined,
    name: row.name,
    baseUrl: row.base_url,
    apiKey,
    thinkingFormat: row.thinking_format as ThinkingFormat,
    protocol: (row.protocol as LLMProtocol | null) ?? undefined,
    defaultModelId: row.default_model_id ?? undefined,
    models: JSON.parse(row.models_json) as LLMModelEntry[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToView(row: ProviderRow, secretKey: Buffer): UserLLMProviderView {
  const record = rowToRecord(row, secretKey);
  return {
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    apiKey: maskSecret(record.apiKey),
    thinkingFormat: record.thinkingFormat,
    protocol: record.protocol || 'openai-completions',
    defaultModelId: record.defaultModelId,
    models: record.models,
    presetId: record.presetId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function systemProviderViews(): UserLLMProviderView[] {
  return getLLMProviderDocument().records.map((record) => ({
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    apiKey: maskSecret(record.apiKey),
    thinkingFormat: record.thinkingFormat,
    protocol: record.protocol || 'openai-completions',
    defaultModelId: record.defaultModelId,
    models: record.models,
    presetId: record.presetId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    readOnly: true,
  }));
}

function mergedRecords(db: SqlDatabase, secretKey: Buffer, userId: string): LLMProviderRecord[] {
  const document = getLLMProviderDocument();
  return [...document.records, ...readUserRows(db, userId).map((row) => rowToRecord(row, secretKey))];
}

function modelOptionsFromRecords(records: LLMProviderRecord[]): UserLLMSettings['modelOptions'] {
  const options: UserLLMSettings['modelOptions'] = {};
  for (const record of records) {
    options[record.id] = record.models.map((model) => ({
      id: model.id,
      label: model.label || model.id,
      ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
      ...(model.reasoningEfforts && Object.keys(model.reasoningEfforts).length
        ? { thinkingLevels: Object.keys(model.reasoningEfforts) }
        : {}),
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
    }));
  }
  return options;
}

/** 当前请求用户的 provider 集合 + 系统预置，供设置页使用。 */
export function getUserLLMSettings(): UserLLMSettings {
  const { db, secretKey, userId } = requireContext();
  const rows = readUserRows(db, userId);
  const bindings = db
    .prepare('SELECT role_id, provider_id, model_id, thinking_level, updated_at FROM user_role_bindings WHERE user_id = ?')
    .all(userId)
    .map((row) => {
      const binding = row as BindingRow;
      return {
        roleId: binding.role_id,
        providerId: binding.provider_id,
        ...(binding.model_id ? { modelId: binding.model_id } : {}),
        ...(binding.thinking_level ? { thinkingLevel: binding.thinking_level } : {}),
        updatedAt: binding.updated_at,
      } satisfies UserRoleBindingView;
    })
    .sort((a, b) => TEAM_ROLE_IDS.indexOf(a.roleId as never) - TEAM_ROLE_IDS.indexOf(b.roleId as never));
  return {
    providers: rows.map((row) => rowToView(row, secretKey)),
    systemProviders: systemProviderViews(),
    roleBindings: bindings,
    modelOptions: modelOptionsFromRecords(mergedRecords(db, secretKey, userId)),
    roles: [...TEAM_ROLE_IDS],
  };
}

export function createUserProvider(value: unknown): UserLLMProviderView {
  const { db, secretKey, userId } = requireContext();
  const input = normalizeProviderInput(value, { requireKey: true });
  const id = `u_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_llm_providers
      (id, user_id, name, base_url, thinking_format, protocol, default_model_id, models_json, api_key_ciphertext, preset_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, input.name, input.baseUrl, input.thinkingFormat, input.protocol, input.defaultModelId ?? null,
    JSON.stringify(input.models), encryptSecret(secretKey, input.apiKey!), input.presetId ?? null, now, now,
  );
  return rowToView(requireRow(db, userId, id), secretKey);
}

export function updateUserProvider(id: string, value: unknown): UserLLMProviderView {
  const { db, secretKey, userId } = requireContext();
  const existing = requireRow(db, userId, id);
  const input = normalizeProviderInput(value, { requireKey: false });
  const apiKeyCiphertext = input.apiKey ? encryptSecret(secretKey, input.apiKey) : existing.api_key_ciphertext;
  db.prepare(`
    UPDATE user_llm_providers
    SET name = ?, base_url = ?, thinking_format = ?, protocol = ?, default_model_id = ?, models_json = ?,
        api_key_ciphertext = ?, preset_id = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `).run(
    input.name, input.baseUrl, input.thinkingFormat, input.protocol, input.defaultModelId ?? null,
    JSON.stringify(input.models), apiKeyCiphertext, input.presetId ?? null, new Date().toISOString(),
    userId, id,
  );
  return rowToView(requireRow(db, userId, id), secretKey);
}

export function deleteUserProvider(id: string): void {
  const { db, userId } = requireContext();
  requireRow(db, userId, id);
  const reference = db
    .prepare('SELECT COUNT(*) AS count FROM user_role_bindings WHERE user_id = ? AND provider_id = ?')
    .get(userId, id) as { count: number } | undefined;
  if (Number(reference?.count ?? 0) > 0) {
    throw new AuthError(409, '该提供商仍被角色绑定，请先解除绑定。');
  }
  db.prepare('DELETE FROM user_llm_providers WHERE user_id = ? AND id = ?').run(userId, id);
}

/** 探测已保存的 provider：路由用它拿解密后的 endpoint，明文只在这里出现。 */
export function getStoredProviderEndpoint(id: string): { baseUrl: string; apiKey: string; protocol: LLMProtocol } {
  const { db, secretKey, userId } = requireContext();
  const record = rowToRecord(requireRow(db, userId, id), secretKey);
  return { baseUrl: record.baseUrl, apiKey: record.apiKey, protocol: record.protocol || 'openai-completions' };
}

export function setUserRoleBinding(roleId: string, value: unknown): void {
  if (!(TEAM_ROLE_IDS as readonly string[]).includes(roleId)) {
    throw new AuthError(400, '未知的角色。');
  }
  const { db, secretKey, userId } = requireContext();
  const source = asRecord(value);
  const providerId = requiredText(source.providerId, ' providerId', 200);
  const provider = mergedRecords(db, secretKey, userId).find((record) => record.id === providerId);
  if (!provider) throw new AuthError(400, '选择的提供商不存在。');
  const modelId = optionalText(source.modelId, 200);
  if (modelId && !provider.models.some((model) => model.id === modelId)) {
    throw new AuthError(400, `模型 ${modelId} 不存在于提供商 ${providerId}。`);
  }
  const thinkingLevel = optionalText(source.thinkingLevel, 100);
  if (thinkingLevel) {
    const model = provider.models.find((candidate) => candidate.id === modelId)
      || provider.models.find((candidate) => candidate.id === provider.defaultModelId)
      || provider.models[0];
    if (!model?.reasoningEfforts?.[thinkingLevel]) {
      throw new AuthError(400, `模型 ${model?.id ?? '默认模型'} 没有思考档位 ${thinkingLevel}。`);
    }
  }
  db.prepare(`
    INSERT INTO user_role_bindings (user_id, role_id, provider_id, model_id, thinking_level, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, role_id) DO UPDATE SET
      provider_id = excluded.provider_id,
      model_id = excluded.model_id,
      thinking_level = excluded.thinking_level,
      updated_at = excluded.updated_at
  `).run(userId, roleId, providerId, modelId || null, thinkingLevel || null, new Date().toISOString());
}

export function clearUserRoleBinding(roleId: string): void {
  if (!(TEAM_ROLE_IDS as readonly string[]).includes(roleId)) {
    throw new AuthError(400, '未知的角色。');
  }
  const { db, userId } = requireContext();
  db.prepare('DELETE FROM user_role_bindings WHERE user_id = ? AND role_id = ?').run(userId, roleId);
}

/**
 * 解析该角色在当前用户下的绑定覆盖；无作用域/无绑定时返回 null，
 * 调用方继续用 agents.json 的角色绑定。
 */
export function resolveRoleBinding(roleId: string): { providerId: string; modelId?: string; thinkingLevel?: string } | null {
  const module = getAuthModule();
  const scope = currentWorkspaceScope();
  if (!scope || !module?.enabled || !module.database) return null;
  const row = module.database
    .prepare('SELECT role_id, provider_id, model_id, thinking_level, updated_at FROM user_role_bindings WHERE user_id = ? AND role_id = ?')
    .get(scope.userId, roleId) as BindingRow | undefined;
  if (!row) return null;
  return {
    providerId: row.provider_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
  };
}

/**
 * 解析顺序的统一入口：有用户作用域时把系统预置与用户 provider 合并后解析；
 * 否则完全走原来的全局逻辑（开发实例/后台任务）。
 */
export function resolveLLMTargetForCurrentUser(input: {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
}): LLMTargetResolution {
  const module = getAuthModule();
  const scope = currentWorkspaceScope();
  if (!scope || !module?.enabled || !module.database || !module.secretKey) {
    return resolveGlobalLLMTarget(input);
  }
  const document = getLLMProviderDocument();
  const records = mergedRecords(module.database, module.secretKey, scope.userId);
  return resolveLLMTargetFromRecords(records, document.defaultProviderId, input);
}
