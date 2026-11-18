import { v4 as uuidv4 } from 'uuid';
import { readConfig, writeConfig } from './file_config.js';
import { assertSecretReferences } from './secret_config.js';

type JsonRecord = Record<string, unknown>;

/**
 * How a thinking level reaches the provider. Only the request body differs;
 * the transport stays OpenAI-compatible for every value.
 *
 * - `openai-effort`:      `{"reasoning_effort": <wire>}`
 * - `anthropic-budget`:   `{"thinking": {"type": "enabled", "budget_tokens": <wire>}}`
 * - `none`:               nothing is sent
 */
export type ThinkingFormat = 'openai-effort' | 'anthropic-budget' | 'none';

export const THINKING_FORMATS: readonly ThinkingFormat[] = ['openai-effort', 'anthropic-budget', 'none'];

/** How a provider reports prefix-cache hits; see `LLMProviderRecord.cacheReport`. */
export type CacheReportMode = 'none' | 'hits-only' | 'full';

export const CACHE_REPORT_MODES: readonly CacheReportMode[] = ['none', 'hits-only', 'full'];

/**
 * Whether the endpoint needs explicit cache breakpoints.
 *
 * `auto` (default) means the server caches prefixes on its own (SGLang RadixAttention,
 * OpenAI, DeepSeek). `explicit` means the request must carry `cache_control` markers
 * (Anthropic Messages and Anthropic-compatible gateways such as DashScope); without them
 * nothing is cached at all, so the wire body is rewritten for these providers only.
 */
export type CacheMode = 'auto' | 'explicit';

export const CACHE_MODES: readonly CacheMode[] = ['auto', 'explicit'];

/**
 * The wire protocol one provider speaks.
 *
 * Every provider configured before this field existed keeps `openai-completions`, so the
 * default is the historical behaviour and the field is optional everywhere. The protocol is
 * a provider property, not a model property: a gateway serves one endpoint contract, and
 * `thinkingFormat`/`cacheMode` stay per-provider for the same reason.
 *
 * - `openai-completions`: `POST {base}/chat/completions`, bearer credential.
 * - `anthropic-messages`: `POST {base}/messages` (or `/v1/messages`), `x-api-key` plus
 *   `anthropic-version`. Needed for Anthropic-native prompt caching (`cache_control`
 *   breakpoints that the OpenAI-compatible shim drops) and a real `thinking` budget.
 * - `openai-responses`: `POST {base}/responses`, bearer credential.
 */
export type LLMProtocol = 'openai-completions' | 'anthropic-messages' | 'openai-responses';

export const LLM_PROTOCOLS: readonly LLMProtocol[] = ['openai-completions', 'anthropic-messages', 'openai-responses'];

/** Where a model entry's metadata came from. Importers may refresh catalog/probe rows only. */
export type ModelMetadataSource = 'catalog' | 'probe' | 'manual';

/** One selectable model under a provider. Credentials never live here. */
export interface LLMModelEntry {
  id: string;
  label?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  /**
   * Level name → the value that actually goes on the wire. A number is only
   * meaningful for `anthropic-budget`, where the value is a token budget; a
   * string is the `reasoning_effort` spelling the endpoint accepts.
   *
   * Keeping the two apart is what makes `max → xhigh` expressible: the level
   * name is what a user picks, the wire value is what this endpoint calls it.
   */
  reasoningEfforts?: Record<string, string | number>;
  /** Which key of `reasoningEfforts` applies when the caller names no level. */
  defaultThinkingLevel?: string;
  /**
   * Declared, not detected. A missing field means "unknown", never "supported":
   * the runtime must not invent a capability the endpoint has not been seen to serve.
   */
  capabilities?: { tools?: boolean; images?: boolean };
  metadataSource?: ModelMetadataSource;
  updatedAt?: string;
}

/**
 * The persisted entity: one endpoint plus its credential, with its models nested.
 * This mirrors the shape every reference implementation converged on
 * (dsh `providers.<route>.models`, opencode `providers.<id>.models`, pi `providers.<id>.models`).
 */
export interface LLMProviderRecord {
  id: string;
  /** The models.dev provider id this record was pre-filled from, or `custom`. */
  presetId?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /**
   * Static HTTP headers every request to this endpoint must carry. OpenCode's
   * Zen/Go gateway, for example, refuses a completion without `x-opencode-session`
   * ("Request is missing x-opencode-session"). Values may use `${ENV_VAR}`
   * references, exactly like `apiKey`; header names that look secret are required
   * to use one.
   */
  headers?: Record<string, string>;
  /** Wire protocol; omitted means `openai-completions`, the behaviour before this field existed. */
  protocol?: LLMProtocol;
  thinkingFormat: ThinkingFormat;
  /**
   * How this endpoint reports prefix-cache hits, because "no counter" is ambiguous.
   *
   * - `none` — the endpoint never reports one. An absent counter is *unknown*.
   * - `hits-only` — it reports a count only when the count is non-zero, which is what
   *   SGLang does for `usage.prompt_tokens_details` even with `--enable-cache-report`.
   *   An absent counter is a *miss*, and treating it as unknown would hide every miss
   *   and report a 100% hit rate.
   * - `full` — it always reports, including an explicit zero (OpenAI, DeepSeek).
   *
   * Defaults to `none` so an endpoint that says nothing is never charged with a miss.
   */
  cacheReport?: CacheReportMode;
  /** `explicit` when the endpoint only caches what the request marks. See `CacheMode`. */
  cacheMode?: CacheMode;
  /** Model used when a caller names a provider but no model. */
  defaultModelId?: string;
  models: LLMModelEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Legacy flat projection: exactly one model of one provider, ready to run.
 *
 * It stays because `agents.json` binds a provider id and every existing consumer
 * (settings payload, `toLlmConfig`) reads these fields. `id` is the provider id, so
 * a binding written before providers existed keeps pointing at the same thing.
 */
export interface LLMProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  model: string;
  contextWindowTokens?: number;
  /** Wire value when it is a string; `undefined` for a numeric budget or no level. */
  thinkingLevel?: string;
  /** Wire value in either representation. Consumers build the request body from this. */
  thinkingWire?: string | number;
  /** Level names this model declares, for building a picker and validating a choice. */
  thinkingLevels?: string[];
  /** Which level `thinkingWire` came from, after applying the caller's choice. */
  thinkingLevelName?: string;
  thinkingFormat: ThinkingFormat;
  /** Resolved wire protocol; `openai-completions` when the record never declared one. */
  protocol: LLMProtocol;
  /** Resolved cache-reporting mode; `none` when the record never declared one. */
  cacheReport: CacheReportMode;
  /** Resolved breakpoint mode; `auto` when the record never declared one. */
  cacheMode: CacheMode;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a caller may write. Every field is optional: the write path accepts both the
 * legacy flat form (`model` / `contextWindowTokens` / `thinkingLevel`, which patch the
 * default model) and the v2 form (`models` / `thinkingFormat` / `defaultModelId`).
 */
export interface LLMProviderInput {
  id?: string;
  name?: string;
  presetId?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  thinkingFormat?: ThinkingFormat;
  protocol?: LLMProtocol;
  defaultModelId?: string;
  models?: LLMModelEntry[];
  model?: string;
  contextWindowTokens?: number;
  thinkingLevel?: string;
  isDefault?: boolean;
}

/** Flat projections: one per provider, using that provider's default model. */
export function getAllLLMProviders(): LLMProvider[] {
  return readDocument().records
    .map((record) => project(record))
    .filter((projection): projection is LLMProvider => Boolean(projection));
}

export function getLLMProvider(id: string): LLMProvider | undefined {
  return getAllLLMProviders().find((provider) => provider.id === id);
}

/**
 * The projection for a specific model. `modelId` is optional: an omitted or unknown
 * id falls back to the provider's default model, matching how a bare provider
 * binding behaved before models were addressable.
 */
export function getLLMTarget(providerId: string, modelId?: string, thinkingLevel?: string): LLMProvider | undefined {
  const record = getLLMProviderRecord(providerId);
  return record ? project(record, modelId, thinkingLevel) : undefined;
}

/** Why a binding did not resolve. The caller maps these to an HTTP status and a message. */
export type LLMTargetFailure = 'no-provider' | 'unknown-provider' | 'no-model' | 'unknown-model' | 'unknown-level';

export type LLMTargetResolution =
  | { ok: true; provider: LLMProvider }
  | { ok: false; reason: LLMTargetFailure; message: string };

/**
 * Resolves "which model should this role run" in one place.
 *
 * A binding that names something absent is an error, never a silent fallback: a deleted
 * provider used to let a role keep running on whichever provider happened to be default,
 * which is indistinguishable from working until the answers change.
 */
export function resolveLLMTarget(input: { providerId?: string; modelId?: string; thinkingLevel?: string }): LLMTargetResolution {
  const document = readDocument();
  return resolveLLMTargetFromRecords(document.records, document.defaultProviderId, input);
}

/**
 * Same resolution against an explicit provider set. Login-enabled deployments merge the
 * user's own providers with the system presets and resolve through here; the global call
 * above is the no-scope case.
 */
export function resolveLLMTargetFromRecords(
  records: LLMProviderRecord[],
  defaultProviderId: string | undefined,
  input: { providerId?: string; modelId?: string; thinkingLevel?: string },
): LLMTargetResolution {
  const requestedProviderId = stringValue(input.providerId).trim();
  const record = requestedProviderId
    ? records.find((candidate) => candidate.id === requestedProviderId)
    : records.find((candidate) => candidate.id === defaultProviderId) || records[0];
  if (!record) {
    return requestedProviderId
      ? { ok: false, reason: 'unknown-provider', message: `LLM provider "${requestedProviderId}" not found.` }
      : { ok: false, reason: 'no-provider', message: 'No LLM provider configured. Please add one in settings.' };
  }
  if (!record.models.length) {
    return { ok: false, reason: 'no-model', message: `LLM provider "${record.id}" has no model. Please add one in settings.` };
  }

  const requestedModelId = stringValue(input.modelId).trim();
  if (requestedModelId && !record.models.some((model) => model.id === requestedModelId)) {
    return { ok: false, reason: 'unknown-model', message: `Model "${requestedModelId}" not found in LLM provider "${record.id}".` };
  }

  const model = pickModel(record, requestedModelId);
  if (!model) {
    return { ok: false, reason: 'no-model', message: `LLM provider "${record.id}" has no model. Please add one in settings.` };
  }

  const requestedLevel = stringValue(input.thinkingLevel).trim();
  const levels = Object.keys(model.reasoningEfforts || {});
  if (requestedLevel && !(requestedLevel in (model.reasoningEfforts || {}))) {
    return {
      ok: false,
      reason: 'unknown-level',
      message: levels.length
        ? `Thinking level "${requestedLevel}" is not declared for model "${model.id}". Available: ${levels.join(', ')}.`
        : `Model "${model.id}" declares no thinking level, so "${requestedLevel}" cannot be sent.`,
    };
  }

  const provider = project(record, requestedModelId, requestedLevel);
  return provider ? { ok: true, provider } : { ok: false, reason: 'no-model', message: `LLM provider "${record.id}" cannot serve a model.` };
}

/** The global provider document (system presets), for merged per-user resolution. */
export function getLLMProviderDocument(): { records: LLMProviderRecord[]; defaultProviderId?: string } {
  return readDocument();
}

/** Projects a stored record into the flat "one model ready to run" shape. */
export function projectLLMProviderRecord(record: LLMProviderRecord, modelId?: string, thinkingLevel?: string): LLMProvider | undefined {
  return project(record, modelId, thinkingLevel);
}

/** What the role editor needs to build its three selectors, keyed by provider id. */
export interface LLMModelOption {
  id: string;
  label: string;
  contextWindowTokens?: number;
  thinkingLevels?: string[];
  capabilities?: { tools?: boolean; images?: boolean };
}

export function getLLMModelOptions(): Record<string, LLMModelOption[]> {
  const options: Record<string, LLMModelOption[]> = {};
  for (const record of readDocument().records) {
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

/** Removes one model row and re-points the default when it was the one removed. */
export function removeProviderModel(providerId: string, modelId: string): LLMProviderRecord | undefined {
  const document = readDocument();
  const index = document.records.findIndex((record) => record.id === providerId);
  if (index < 0) return undefined;
  const record = document.records[index];
  const models = record.models.filter((model) => model.id !== modelId);
  if (models.length === record.models.length) return record;
  if (!models.length) throw new Error('供应商至少需要保留一个模型。');
  const updated: LLMProviderRecord = {
    ...record,
    models,
    defaultModelId: record.defaultModelId === modelId ? models[0].id : record.defaultModelId,
    updatedAt: new Date().toISOString(),
  };
  document.records[index] = updated;
  save(document.records, document.defaultProviderId);
  return updated;
}

export function getAllLLMProviderRecords(): LLMProviderRecord[] {
  return readDocument().records;
}

export function getLLMProviderRecord(id: string): LLMProviderRecord | undefined {
  return readDocument().records.find((record) => record.id === id);
}

export function createLLMProvider(data: LLMProviderInput): LLMProvider {
  const now = new Date().toISOString();
  const id = stringValue(data.id).trim() || uuidv4();
  const record = normalizeInput(data as unknown as JsonRecord, { id, now });
  assertValidRecord(record);
  const document = readDocument();
  document.records.push(record);
  const nextDefault = Boolean(data.isDefault) ? id : document.defaultProviderId;
  save(document.records, nextDefault);
  return project(record)!;
}

export function updateLLMProvider(id: string, data: LLMProviderInput): LLMProvider | undefined {
  const document = readDocument();
  const index = document.records.findIndex((record) => record.id === id);
  if (index < 0) return undefined;
  // Only the patch is passed in: spreading the record would make `models` always present
  // and silently skip the legacy flat path that patches the default model.
  const merged = normalizeInput(data as unknown as JsonRecord, { id, now: new Date().toISOString(), existing: document.records[index] });
  assertValidRecord(merged);
  document.records[index] = merged;
  let nextDefault = document.defaultProviderId;
  if (data.isDefault === true) nextDefault = id;
  else if (data.isDefault === false && nextDefault === id) nextDefault = document.records.find((record) => record.id !== id)?.id;
  save(document.records, nextDefault);
  return project(merged);
}

export function deleteLLMProvider(id: string): boolean {
  const document = readDocument();
  const next = document.records.filter((record) => record.id !== id);
  if (next.length === document.records.length) return false;
  const nextDefault = document.defaultProviderId === id ? next[0]?.id : document.defaultProviderId;
  save(next, nextDefault);
  return true;
}

/**
 * Raw provider documents, for config export/import. The bundle format is the same
 * v2 shape the file uses, never the legacy flat array.
 */
export function getRawLLMProviders(): JsonRecord[] {
  return readDocument().records.map(toRawRecord);
}

/**
 * Replaces the whole provider set. Accepts either the v2 shape or the legacy flat
 * array so an exported bundle from before this schema change still imports.
 */
export function replaceLLMProviders(values: unknown[]): void {
  const records = values.filter(isRecord).map((value) => toRecord(value, { now: new Date().toISOString() }));
  records.forEach(assertValidRecord);
  const explicitDefault = values.filter(isRecord).find((value) => value.isDefault === true);
  const defaultId = stringValue(explicitDefault?.id).trim() || records[0]?.id;
  save(records, defaultId);
}

/** Adds or replaces model entries on an existing provider without touching its credential. */
export function upsertProviderModels(providerId: string, entries: LLMModelEntry[], source: ModelMetadataSource = 'manual'): LLMProviderRecord | undefined {
  const document = readDocument();
  const index = document.records.findIndex((record) => record.id === providerId);
  if (index < 0) return undefined;
  const record = document.records[index];
  const next = [...record.models];
  for (const entry of entries) {
    const id = stringValue(entry.id).trim();
    if (!id) continue;
    const existingIndex = next.findIndex((model) => model.id === id);
    const normalized = normalizeModelEntry({ ...entry, id }, source);
    if (existingIndex < 0) {
      next.push(normalized);
      continue;
    }
    // An importer never overwrites a hand-written row or a field the user renamed.
    if (next[existingIndex].metadataSource === 'manual') continue;
    next[existingIndex] = { ...next[existingIndex], ...normalized };
  }
  const updated: LLMProviderRecord = {
    ...record,
    models: next,
    defaultModelId: record.defaultModelId && next.some((model) => model.id === record.defaultModelId) ? record.defaultModelId : next[0]?.id,
    updatedAt: new Date().toISOString(),
  };
  document.records[index] = updated;
  save(document.records, document.defaultProviderId);
  return updated;
}

interface LLMDocument {
  records: LLMProviderRecord[];
  defaultProviderId?: string;
}

function readDocument(): LLMDocument {
  const raw = readConfig('llm.json');
  const now = new Date().toISOString();
  // v3 (object) and v1/v2 (array of flat records, or `{providers: [...]}`) both land here.
  const items = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.providers) ? raw.providers : [];
  const records = items.filter(isRecord).map((item) => toRecord(item, { now }));
  const explicitDefault = items.filter(isRecord).find((item) => item.isDefault === true);
  const storedDefault = isRecord(raw) ? stringValue(raw.defaultProviderId).trim() : '';
  const defaultProviderId = records.some((record) => record.id === storedDefault)
    ? storedDefault
    : stringValue(explicitDefault?.id).trim() || records[0]?.id;
  return { records, defaultProviderId: defaultProviderId || undefined };
}

function save(records: LLMProviderRecord[], defaultProviderId?: string): void {
  writeConfig('llm.json', {
    schemaVersion: 2,
    ...(defaultProviderId ? { defaultProviderId } : {}),
    providers: records.map(toRawRecord),
  });
}

function project(record: LLMProviderRecord, requestedModelId?: string, requestedLevel?: string): LLMProvider | undefined {
  const model = pickModel(record, requestedModelId);
  if (!model) return undefined;
  const levels = Object.keys(model.reasoningEfforts || {});
  const level = pickLevel(model, requestedLevel);
  const wire = level ? model.reasoningEfforts?.[level] : undefined;
  return {
    id: record.id,
    // Provider name, never the default model's label: the role picker shows the model
    // separately, and the editor writes this field back when a provider is saved.
    name: record.name || record.id,
    baseUrl: record.baseUrl,
    apiKey: record.apiKey,
    ...(record.headers && Object.keys(record.headers).length ? { headers: { ...record.headers } } : {}),
    model: model.id,
    contextWindowTokens: model.contextWindowTokens,
    thinkingLevel: typeof wire === 'string' ? wire : undefined,
    thinkingWire: typeof wire === 'string' || typeof wire === 'number' ? wire : undefined,
    ...(levels.length ? { thinkingLevels: levels } : {}),
    ...(level ? { thinkingLevelName: level } : {}),
    thinkingFormat: record.thinkingFormat,
    protocol: record.protocol || 'openai-completions',
    cacheReport: record.cacheReport || 'none',
    cacheMode: record.cacheMode || 'auto',
    isDefault: record.id === readDocument().defaultProviderId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function pickModel(record: LLMProviderRecord, requestedModelId?: string): LLMModelEntry | undefined {
  const wanted = stringValue(requestedModelId).trim();
  if (wanted) {
    const match = record.models.find((model) => model.id === wanted);
    if (match) return match;
  }
  const preferred = stringValue(record.defaultModelId).trim();
  return record.models.find((model) => model.id === preferred) || record.models[0];
}

/**
 * The level in force: the caller's choice when it is declared, otherwise the model's
 * default. An undeclared choice returns `undefined` rather than falling back silently —
 * sending an unmapped level is exactly the 400 this split exists to avoid.
 */
function pickLevel(model: LLMModelEntry, requestedLevel?: string): string | undefined {
  const efforts = model.reasoningEfforts || {};
  const wanted = stringValue(requestedLevel).trim();
  if (wanted) return wanted in efforts ? wanted : undefined;
  const preferred = stringValue(model.defaultThinkingLevel).trim();
  if (preferred && preferred in efforts) return preferred;
  const first = Object.keys(efforts)[0];
  return first;
}

/** Accepts a legacy flat record, the v2 shape, or a mix — every persisted row becomes v2. */
function toRecord(value: JsonRecord, options: { now: string }): LLMProviderRecord {
  if (Array.isArray(value.models)) return normalizeRecord(value, options.now);
  return fromLegacyRecord(value, options.now);
}

function fromLegacyRecord(value: JsonRecord, now: string): LLMProviderRecord {
  const modelId = stringValue(value.model);
  const contextWindowTokens = positiveInteger(value.contextWindowTokens ?? value.context_window_tokens);
  const thinkingLevel = nonEmptyString(value.thinkingLevel ?? value.thinking_level);
  const createdAt = stringValue(value.createdAt) || now;
  return {
    id: stringValue(value.id),
    presetId: nonEmptyString(value.presetId) || 'custom',
    name: nonEmptyString(value.name) || stringValue(value.id),
    baseUrl: stringValue(value.baseUrl ?? value.base_url),
    apiKey: stringValue(value.apiKey ?? value.api_key),
    headers: headersValue(value.headers),
    thinkingFormat: thinkingFormatValue(value.thinkingFormat),
    protocol: protocolValue(value.protocol),
    cacheReport: cacheReportValue(value.cacheReport),
    cacheMode: cacheModeValue(value.cacheMode),
    defaultModelId: modelId || undefined,
    models: modelId
      ? [{
        id: modelId,
        label: nonEmptyString(value.label) || modelId,
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
        // A level and its wire spelling were the same string before the split, so the
        // map is an identity table: behaviour is unchanged until someone edits it.
        ...(thinkingLevel ? { reasoningEfforts: { [thinkingLevel]: thinkingLevel }, defaultThinkingLevel: thinkingLevel } : {}),
        capabilities: capabilitiesValue(value.capabilities),
        metadataSource: metadataSourceValue(value.metadataSource) || 'manual',
        updatedAt: stringValue(value.updatedAt) || now,
      }]
      : [],
    createdAt,
    updatedAt: stringValue(value.updatedAt) || createdAt,
  };
}

function normalizeRecord(value: JsonRecord, now: string): LLMProviderRecord {
  const createdAt = stringValue(value.createdAt) || now;
  const models = (Array.isArray(value.models) ? value.models : [])
    .filter(isRecord)
    .map((entry) => normalizeModelEntry(entry, metadataSourceValue(value.metadataSource) || 'manual'))
    .filter((entry) => entry.id);
  return {
    id: stringValue(value.id),
    presetId: nonEmptyString(value.presetId),
    name: nonEmptyString(value.name) || stringValue(value.id),
    baseUrl: stringValue(value.baseUrl ?? value.base_url),
    apiKey: stringValue(value.apiKey ?? value.api_key),
    headers: headersValue(value.headers),
    thinkingFormat: thinkingFormatValue(value.thinkingFormat),
    protocol: protocolValue(value.protocol),
    cacheReport: cacheReportValue(value.cacheReport),
    cacheMode: cacheModeValue(value.cacheMode),
    defaultModelId: nonEmptyString(value.defaultModelId),
    models,
    createdAt,
    updatedAt: stringValue(value.updatedAt) || createdAt,
  };
}

function normalizeInput(
  data: JsonRecord,
  options: { id: string; now: string; existing?: LLMProviderRecord },
): LLMProviderRecord {
  const existing = options.existing;
  const createdAt = existing?.createdAt || stringValue(data.createdAt) || options.now;
  const hasModelsInput = Array.isArray(data.models);

  // Legacy flat write path: the UI still sends one model per record until the agent
  // page exists. It patches `model`/`contextWindowTokens`/`thinkingLevel` on the
  // default model instead of introducing a second shape.
  const patched = hasModelsInput ? undefined : patchDefaultModel(existing, data, options.now);
  const models = hasModelsInput
    ? (data.models as unknown[]).filter(isRecord).map((entry) => normalizeModelEntry(entry, 'manual'))
    : patched;

  return {
    id: options.id,
    presetId: nonEmptyString(data.presetId) ?? existing?.presetId,
    name: nonEmptyString(data.name) || existing?.name || options.id,
    baseUrl: stringValue(data.baseUrl ?? data.base_url) || existing?.baseUrl || '',
    apiKey: stringValue(data.apiKey ?? data.api_key) || existing?.apiKey || '',
    // `headers` is optional in every write shape. Omitting it must preserve what the
    // record already had, while an explicit `{}` clears it.
    headers: 'headers' in data ? headersValue(data.headers, { strict: true }) : existing?.headers,
    thinkingFormat: 'thinkingFormat' in data ? thinkingFormatValue(data.thinkingFormat) : existing?.thinkingFormat || 'openai-effort',
    // A write either states the protocol or leaves the record's own value alone; a new
    // record with no field stays on the default. Unknown values are rejected, not coerced:
    // silently falling back would run the wrong wire protocol against a live endpoint.
    protocol: 'protocol' in data ? protocolInput(data.protocol) : existing?.protocol,
    // Like `headers`: an omitted field preserves the record, so the Web settings form
    // cannot silently downgrade a provider to "reports nothing".
    cacheReport: 'cacheReport' in data ? cacheReportValue(data.cacheReport) : existing?.cacheReport,
    cacheMode: 'cacheMode' in data ? cacheModeValue(data.cacheMode) : existing?.cacheMode,
    defaultModelId: 'defaultModelId' in data
      ? nonEmptyString(data.defaultModelId)
      : (existing?.defaultModelId || models?.[0]?.id),
    models: models ?? existing?.models ?? [],
    createdAt,
    updatedAt: options.now,
  };
}

/**
 * Applies a legacy flat update to the default model. Fields the caller did not send are
 * preserved, so touching `baseUrl` alone never clears a model's context window.
 */
function patchDefaultModel(existing: LLMProviderRecord | undefined, data: JsonRecord, now: string): LLMModelEntry[] {
  const legacyModelId = stringValue(data.model).trim();
  const contextWindowTokens = positiveInteger(data.contextWindowTokens ?? data.context_window_tokens);
  const thinkingLevel = nonEmptyString(data.thinkingLevel ?? data.thinking_level);
  const touchesModel = Boolean(legacyModelId) || contextWindowTokens !== undefined || thinkingLevel !== undefined || 'contextWindowTokens' in data || 'thinkingLevel' in data;
  if (!existing) {
    return legacyModelId ? [normalizeModelEntry({
      id: legacyModelId,
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
      ...(thinkingLevel ? { reasoningEfforts: { [thinkingLevel]: thinkingLevel }, defaultThinkingLevel: thinkingLevel } : {}),
      updatedAt: now,
    }, 'manual')] : [];
  }
  if (!touchesModel) return existing.models;
  const models = existing.models.map((model) => ({ ...model }));
  const index = Math.max(0, models.findIndex((model) => model.id === (legacyModelId || existing.defaultModelId || models[0]?.id)));
  if (!models[index]) return models;
  const target = models[index];
  if (legacyModelId) target.id = legacyModelId;
  if (contextWindowTokens) target.contextWindowTokens = contextWindowTokens;
  if (thinkingLevel) {
    target.reasoningEfforts = { ...(target.reasoningEfforts || {}), [thinkingLevel]: thinkingLevel };
    target.defaultThinkingLevel = thinkingLevel;
  }
  target.updatedAt = now;
  return models;
}

function normalizeModelEntry(value: JsonRecord, source: ModelMetadataSource): LLMModelEntry {
  const id = stringValue(value.id).trim();
  const reasoningEfforts = normalizeReasoningEfforts(value.reasoningEfforts);
  const defaultThinkingLevel = nonEmptyString(value.defaultThinkingLevel);
  return {
    id,
    ...(nonEmptyString(value.label) ? { label: nonEmptyString(value.label) } : {}),
    ...(positiveInteger(value.contextWindowTokens) ? { contextWindowTokens: positiveInteger(value.contextWindowTokens) } : {}),
    ...(positiveInteger(value.maxOutputTokens) ? { maxOutputTokens: positiveInteger(value.maxOutputTokens) } : {}),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(defaultThinkingLevel && reasoningEfforts && defaultThinkingLevel in reasoningEfforts ? { defaultThinkingLevel } : {}),
    ...(capabilitiesValue(value.capabilities) ? { capabilities: capabilitiesValue(value.capabilities) } : {}),
    metadataSource: metadataSourceValue(value.metadataSource) || source,
    ...(stringValue(value.updatedAt) ? { updatedAt: stringValue(value.updatedAt) } : {}),
  };
}

function normalizeReasoningEfforts(value: unknown): Record<string, string | number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([level, wire]) => Boolean(level.trim()) && (typeof wire === 'string' || typeof wire === 'number'));
  return entries.length ? Object.fromEntries(entries) as Record<string, string | number> : undefined;
}

/**
 * Header names are RFC 9110 tokens; values may not contain CR/LF (header injection).
 * The read path drops invalid pairs so one bad config line cannot break every
 * settings read; the write path throws so the mistake is fixed where it was made.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function headersValue(value: unknown, options: { strict?: boolean } = {}): Record<string, string> | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) {
    if (options.strict) throw new Error('headers 必须是「请求头名称 → 值」的对象。');
    return undefined;
  }
  const entries: Array<[string, string]> = [];
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim();
    const headerValue = typeof rawValue === 'string' ? rawValue.trim() : '';
    const valid = HEADER_NAME_PATTERN.test(name) && Boolean(headerValue) && !/[\r\n]/.test(headerValue);
    if (!valid && options.strict) {
      throw new Error(`请求头「${rawName}」无效：名称必须是 HTTP token，值必须是非空且不含换行的字符串。`);
    }
    if (valid) entries.push([name, headerValue]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function capabilitiesValue(value: unknown): { tools?: boolean; images?: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  const tools = typeof value.tools === 'boolean' ? value.tools : undefined;
  const images = typeof value.images === 'boolean' ? value.images : undefined;
  if (tools === undefined && images === undefined) return undefined;
  return { ...(tools === undefined ? {} : { tools }), ...(images === undefined ? {} : { images }) };
}

function thinkingFormatValue(value: unknown): ThinkingFormat {
  const text = stringValue(value).trim();
  return (THINKING_FORMATS as readonly string[]).includes(text) ? text as ThinkingFormat : 'openai-effort';
}

/**
 * Coerce a stored cache-report mode, falling back to `none`.
 *
 * `none` is the only safe default: it means "an absent counter is unknown". Defaulting to
 * `hits-only` would turn every unreported request into a miss and understate the hit rate
 * of endpoints that simply do not count.
 */
function cacheModeValue(value: unknown): CacheMode {
  const text = stringValue(value).trim();
  return (CACHE_MODES as readonly string[]).includes(text) ? text as CacheMode : 'auto';
}

function cacheReportValue(value: unknown): CacheReportMode {
  const text = stringValue(value).trim();
  return (CACHE_REPORT_MODES as readonly string[]).includes(text) ? text as CacheReportMode : 'none';
}

/** Tolerant read: an unknown or absent protocol means the historical default. */
function protocolValue(value: unknown): LLMProtocol | undefined {
  const text = stringValue(value).trim();
  return (LLM_PROTOCOLS as readonly string[]).includes(text) ? text as LLMProtocol : undefined;
}

/** Strict write: an explicit value must be one of the three, or it is a configuration error. */
function protocolInput(value: unknown): LLMProtocol | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = stringValue(value).trim();
  if (!(LLM_PROTOCOLS as readonly string[]).includes(text)) {
    throw new Error(`未知的协议「${text}」，可选值为 ${LLM_PROTOCOLS.join(' / ')}。`);
  }
  return text as LLMProtocol;
}

function metadataSourceValue(value: unknown): ModelMetadataSource | undefined {
  const text = stringValue(value).trim();
  return text === 'catalog' || text === 'probe' || text === 'manual' ? text : undefined;
}

function toRawRecord(record: LLMProviderRecord): JsonRecord {
  return {
    id: record.id,
    ...(record.presetId ? { presetId: record.presetId } : {}),
    name: record.name,
    baseUrl: record.baseUrl,
    apiKey: record.apiKey,
    ...(record.headers && Object.keys(record.headers).length ? { headers: record.headers } : {}),
    thinkingFormat: record.thinkingFormat,
    ...(record.protocol ? { protocol: record.protocol } : {}),
    ...(record.cacheReport ? { cacheReport: record.cacheReport } : {}),
    ...(record.cacheMode ? { cacheMode: record.cacheMode } : {}),
    ...(record.defaultModelId ? { defaultModelId: record.defaultModelId } : {}),
    models: record.models.map((model) => ({
      id: model.id,
      ...(model.label ? { label: model.label } : {}),
      ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
      ...(model.defaultThinkingLevel ? { defaultThinkingLevel: model.defaultThinkingLevel } : {}),
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      ...(model.metadataSource ? { metadataSource: model.metadataSource } : {}),
      ...(model.updatedAt ? { updatedAt: model.updatedAt } : {}),
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function assertValidRecord(record: LLMProviderRecord): void {
  if (!stringValue(record.baseUrl) || !stringValue(record.apiKey)) {
    throw new Error('baseUrl 与 apiKey 均为必填项。');
  }
  // Re-normalizing in strict mode rejects invalid names/values and CR/LF injection.
  headersValue(record.headers, { strict: true });
  if (!record.models.length) {
    throw new Error('至少需要一个模型：请先探测端点或手动添加一个模型。');
  }
  record.models.forEach((model) => {
    if (!stringValue(model.id)) throw new Error('模型 ID 不能为空。');
    if (record.thinkingFormat === 'anthropic-budget') {
      // The budget encoding has no string form: sending "high" as budget_tokens would be
      // silently dropped, so the mismatch is reported where it can still be corrected.
      for (const [level, wire] of Object.entries(model.reasoningEfforts || {})) {
        if (typeof wire !== 'number' || !Number.isFinite(wire) || wire <= 0) {
          throw new Error(`模型「${model.id}」的档位「${level}」必须是大于 0 的 token 预算数字（当前思考格式为 anthropic-budget）。`);
        }
      }
    }
    if (model.defaultThinkingLevel && (!model.reasoningEfforts || !(model.defaultThinkingLevel in model.reasoningEfforts))) {
      throw new Error(`模型 ${model.id} 的默认思考档位「${model.defaultThinkingLevel}」不在候选集中。`);
    }
  });
  assertSecretReferences(record, 'llm provider');
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function nonEmptyString(value: unknown): string | undefined {
  const text = stringValue(value).trim();
  return text || undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
