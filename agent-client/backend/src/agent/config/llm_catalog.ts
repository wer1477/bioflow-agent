import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_ROOT } from '../../paths.js';
import type { LLMModelEntry, LLMProtocol, ThinkingFormat } from './llm_config_store.js';

/**
 * Read-only access to the bundled models.dev catalog.
 *
 * The file is a build artifact (`node scripts/generate-llm-catalog.mjs`) that ships with
 * the checkout, so this module never reaches the network. It is also the only place that
 * knows the shortened field names the generator writes.
 */

export interface CatalogModel {
  id: string;
  name: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: Record<string, string>;
  capabilities?: { tools?: boolean; images?: boolean };
}

export interface CatalogProvider {
  id: string;
  name: string;
  api?: string;
  env: string[];
  npm?: string;
  /**
   * A hint, never an applied value. The catalog records the SDK an upstream package uses,
   * not which encoding this deployment's endpoint accepts, so the user still chooses.
   */
  suggestedThinkingFormat: ThinkingFormat;
  /**
   * Wire protocol the preset speaks, when the overlay declares one (Anthropic Messages).
   * Absent means `openai-completions`, which is what every preset shipped before the
   * protocol existed.
   */
  protocol?: LLMProtocol;
  /** Shown in the first preset group; curated by `llm_presets.json`, not by models.dev. */
  featured?: boolean;
  priority?: number;
  models: CatalogModel[];
}

interface CatalogDocument {
  generatedAt?: string;
  providers?: Record<string, RawProvider>;
}

/**
 * Hand-maintained overlay for the providers people actually use.
 *
 * models.dev describes SDK packages, not this deployment's OpenAI-compatible transport: several
 * mainstream providers have no `api` in its document, and a few (Anthropic, MiniMax) publish an
 * endpoint whose native protocol is not Chat Completions. The overlay therefore carries the
 * compatible base URL, a curated model order, and the featured ranking used by the settings UI.
 * Regenerating `llm_catalog.json` never removes these values.
 */
interface PresetDocument {
  providers?: PresetProvider[];
}

/**
 * A preset carries only the deltas the generated catalog cannot know: the compatible endpoint,
 * the display name, the thinking encoding, the curated model order and the featured ranking.
 * Credentials and environment-variable names stay with the catalog (or the provider record), so
 * the overlay never duplicates them.
 */
interface PresetProvider {
  id?: string;
  name?: string;
  api?: string;
  thinkingFormat?: string;
  protocol?: string;
  featured?: boolean;
  priority?: number;
  /**
   * Curated catalog models, in display order. An empty list means "probe the endpoint". When every
   * id has rotated out of the catalog the preset falls back to the catalog's full list, so a stale
   * curation never turns into an empty provider.
   */
  modelIds?: string[];
}

interface RawProvider {
  name?: string;
  api?: string;
  env?: string[];
  npm?: string;
  models?: Record<string, RawModel>;
}

interface RawModel {
  name?: string;
  c?: number;
  o?: number;
  r?: boolean;
  eff?: string[];
  t?: boolean;
  img?: boolean;
}

const EMPTY: CatalogDocument = { providers: {} };
const EMPTY_PRESETS: PresetDocument = { providers: [] };
let cache: { key: string; document: CatalogDocument } | null = null;
let presetCache: { key: string; document: PresetDocument } | null = null;

export function getCatalogGeneratedAt(): string | undefined {
  return loadDocument().generatedAt;
}

/**
 * Provider presets, searched by id, name or base URL.
 *
 * Curated providers come first (`featured`, then `priority`); the rest keep the historical
 * "most models first" order. The overlay can also add a provider that models.dev does not list
 * (Ollama), in which case `modelCount` is 0 and the UI falls back to probing the endpoint.
 */
export function listCatalogProviders(query = ''): (Omit<CatalogProvider, 'models'> & { modelCount: number })[] {
  const needle = query.trim().toLowerCase();
  const catalog = loadDocument().providers || {};
  const presets = presetIndex();
  const ids = new Set([...Object.keys(catalog), ...presets.keys()]);
  return [...ids]
    .map((id) => {
      const provider = catalog[id];
      const preset = presets.get(id);
      const models = provider?.models || {};
      const modelCount = presetModelCount(models, preset);
      const summary = {
        id,
        name: text(preset?.name) || text(provider?.name) || id,
        ...(text(preset?.api) || text(provider?.api) ? { api: text(preset?.api) || text(provider?.api) } : {}),
        env: Array.isArray(provider?.env) ? provider.env.filter((name) => typeof name === 'string' && name) : [],
        ...(text(provider?.npm) ? { npm: text(provider?.npm) } : {}),
        suggestedThinkingFormat: presetThinkingFormat(preset) || suggestThinkingFormat(provider?.npm),
        ...(presetProtocol(preset) ? { protocol: presetProtocol(preset) } : {}),
        modelCount,
        ...(preset?.featured ? { featured: true } : {}),
        ...(Number.isFinite(preset?.priority) ? { priority: preset?.priority } : {}),
      };
      return { summary, haystack: `${id} ${summary.name} ${summary.api || ''}`.toLowerCase() };
    })
    .filter(({ haystack }) => !needle || haystack.includes(needle))
    .sort((a, b) => Number(b.summary.featured) - Number(a.summary.featured)
      || (b.summary.priority || 0) - (a.summary.priority || 0)
      || b.summary.modelCount - a.summary.modelCount
      || a.summary.id.localeCompare(b.summary.id))
    .map(({ summary }) => summary);
}

export function getCatalogProvider(id: string): CatalogProvider | undefined {
  const provider = (loadDocument().providers || {})[id];
  const preset = presetIndex().get(id);
  if (!provider && !preset) return undefined;
  const models = toCatalogModels(provider?.models || {});
  return {
    id,
    name: text(preset?.name) || text(provider?.name) || id,
    ...(text(preset?.api) || text(provider?.api) ? { api: text(preset?.api) || text(provider?.api) } : {}),
    env: Array.isArray(provider?.env) ? provider.env.filter((name) => typeof name === 'string' && name) : [],
    ...(text(provider?.npm) ? { npm: text(provider?.npm) } : {}),
    suggestedThinkingFormat: presetThinkingFormat(preset) || suggestThinkingFormat(provider?.npm),
    ...(presetProtocol(preset) ? { protocol: presetProtocol(preset) } : {}),
    ...(preset?.featured ? { featured: true } : {}),
    ...(Number.isFinite(preset?.priority) ? { priority: preset?.priority } : {}),
    models: selectPresetModels(models, preset?.modelIds),
  };
}

/** Catalog models as provider-config entries, ready for `upsertProviderModels`. */
export function catalogModelsAsEntries(models: CatalogModel[]): LLMModelEntry[] {
  return models.map((model) => ({
    id: model.id,
    ...(model.name && model.name !== model.id ? { label: model.name } : {}),
    ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.reasoningEfforts ? { reasoningEfforts: { ...model.reasoningEfforts }, defaultThinkingLevel: firstLevel(model.reasoningEfforts) } : {}),
    ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
    metadataSource: 'catalog' as const,
  }));
}

export function suggestThinkingFormat(npm: unknown): ThinkingFormat {
  const name = text(npm).toLowerCase();
  return name.includes('anthropic') ? 'anthropic-budget' : 'openai-effort';
}

/** Test hook: forces the next read to hit disk again. */
export function resetCatalogCache(): void {
  cache = null;
  presetCache = null;
}

function loadDocument(): CatalogDocument {
  const file = path.join(process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT, 'llm_catalog.json');
  let key = `${file}:missing`;
  try {
    key = `${file}:${fs.statSync(file).mtimeMs}`;
  } catch {
    // A checkout without a generated catalog still starts; presets are simply empty.
    return EMPTY;
  }
  if (cache?.key === key) return cache.document;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as CatalogDocument;
    const document = parsed && typeof parsed === 'object' ? parsed : EMPTY;
    cache = { key, document };
    return document;
  } catch {
    return EMPTY;
  }
}

/**
 * Loads the hand-maintained provider overlay. The file is optional: an old checkout, or a
 * deployment using `BIOFLOW_CONFIG_DIR` without it, keeps working with the raw catalog.
 */
function loadPresets(): PresetDocument {
  const file = path.join(process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT, 'llm_presets.json');
  let key = `${file}:missing`;
  try {
    key = `${file}:${fs.statSync(file).mtimeMs}`;
  } catch {
    return EMPTY_PRESETS;
  }
  if (presetCache?.key === key) return presetCache.document;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as PresetDocument;
    const document = parsed && typeof parsed === 'object' ? parsed : EMPTY_PRESETS;
    presetCache = { key, document };
    return document;
  } catch {
    return EMPTY_PRESETS;
  }
}

function presetIndex(): Map<string, PresetProvider> {
  const index = new Map<string, PresetProvider>();
  for (const preset of loadPresets().providers || []) {
    if (!preset || typeof preset !== 'object') continue;
    const id = text(preset.id);
    if (!id) continue;
    index.set(id, normalizePreset(preset));
  }
  return index;
}

function normalizePreset(preset: PresetProvider): PresetProvider {
  const thinkingFormat = presetThinkingFormat(preset);
  return {
    id: text(preset.id),
    ...(text(preset.name) ? { name: text(preset.name) } : {}),
    ...(text(preset.api) ? { api: text(preset.api) } : {}),
    ...(thinkingFormat ? { thinkingFormat } : {}),
    ...(presetProtocol(preset) ? { protocol: presetProtocol(preset) } : {}),
    ...(preset.featured === true ? { featured: true } : {}),
    ...(Number.isFinite(preset.priority) ? { priority: Number(preset.priority) } : {}),
    ...(Array.isArray(preset.modelIds)
      ? { modelIds: preset.modelIds.filter((modelId) => typeof modelId === 'string' && modelId.trim()).map((modelId) => modelId.trim()) }
      : {}),
  };
}

/**
 * Curated order wins; ids missing from the generated catalog are skipped, never invented.
 *
 * Two edge cases are deliberate. An empty list is an endpoint-only preset (Ollama, LM Studio):
 * the editor probes it instead of guessing. A non-empty list that matches nothing means the
 * catalog rotated under a stale curation, so the provider falls back to the catalog's full list
 * rather than appearing empty.
 */
function selectPresetModels(models: CatalogModel[], modelIds: string[] | undefined): CatalogModel[] {
  if (!modelIds) return models;
  const byId = new Map(models.map((model) => [model.id, model]));
  const curated = modelIds.map((modelId) => byId.get(modelId)).filter((model): model is CatalogModel => Boolean(model));
  if (curated.length || !modelIds.length) return curated;
  return models;
}

/** The `modelCount` a summary reports, computed without materializing every catalog model. */
function presetModelCount(rawModels: Record<string, RawModel>, preset: PresetProvider | undefined): number {
  const total = Object.values(rawModels).filter((model) => Boolean(model) && typeof model === 'object').length;
  if (!preset?.modelIds) return total;
  const matched = preset.modelIds.filter((modelId) => Boolean(rawModels[modelId])).length;
  return matched || (preset.modelIds.length ? total : 0);
}

function presetThinkingFormat(preset: PresetProvider | undefined): ThinkingFormat | undefined {
  const value = preset?.thinkingFormat;
  return value === 'openai-effort' || value === 'anthropic-budget' || value === 'none' ? value : undefined;
}

/** An unknown protocol is dropped, not guessed: absent already means openai-completions. */
function presetProtocol(preset: PresetProvider | undefined): LLMProtocol | undefined {
  const value = preset?.protocol;
  return value === 'openai-completions' || value === 'anthropic-messages' || value === 'openai-responses' ? value : undefined;
}

function toCatalogModels(models: Record<string, RawModel>): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const [key, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object') continue;
    const id = key.trim();
    if (!id) continue;
    const efforts = Array.isArray(model.eff)
      ? model.eff.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim())
      : [];
    out.push({
      id,
      name: text(model.name) || id,
      ...(positive(model.c) ? { contextWindowTokens: positive(model.c) } : {}),
      ...(positive(model.o) ? { maxOutputTokens: positive(model.o) } : {}),
      // Level names map to themselves. A deployment whose endpoint uses different spellings
      // edits the map; nothing here claims to know a gateway's dialect.
      ...(efforts.length ? { reasoningEfforts: Object.fromEntries(efforts.map((name) => [name, name])) } : {}),
      ...(capability(model) ? { capabilities: capability(model) } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function capability(model: RawModel): { tools?: boolean; images?: boolean } | undefined {
  const tools = model.t === true ? true : undefined;
  const images = model.img === true ? true : undefined;
  if (tools === undefined && images === undefined) return undefined;
  return { ...(tools === undefined ? {} : { tools }), ...(images === undefined ? {} : { images }) };
}

function firstLevel(efforts: Record<string, string>): string | undefined {
  return Object.keys(efforts)[0];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
