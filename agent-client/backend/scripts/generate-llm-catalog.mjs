/**
 * Regenerates `config/llm_catalog.json` from models.dev.
 *
 * The catalog is a build artifact, not a runtime dependency: the server must start and
 * configure a provider with no network at all. Run this when you want newer upstream
 * metadata, then commit the result.
 *
 *   node scripts/generate-llm-catalog.mjs
 *
 * Field names are shortened (`c`/`o`/`eff`) because this file ships with the checkout and
 * is roughly a quarter the size of the upstream document for identical information.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://models.dev/api.json';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.BIOFLOW_LLM_CATALOG_OUT || path.join(root, 'config', 'llm_catalog.json');

const response = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
const upstream = await response.json();

const providers = {};
let modelCount = 0;
for (const [id, provider] of Object.entries(upstream || {})) {
  if (!provider || typeof provider !== 'object') continue;
  const models = {};
  for (const [modelKey, model] of Object.entries(provider.models || {})) {
    const entry = leanModel(model);
    if (!entry) continue;
    models[String(model?.id || modelKey)] = entry;
    modelCount += 1;
  }
  providers[id] = {
    name: text(provider.name) || id,
    ...(text(provider.api) ? { api: text(provider.api) } : {}),
    ...(Array.isArray(provider.env) && provider.env.length ? { env: provider.env.map(text).filter(Boolean) } : {}),
    ...(text(provider.npm) ? { npm: text(provider.npm) } : {}),
    models,
  };
}

const document = {
  sourceUrl: SOURCE,
  generatedAt: new Date().toISOString(),
  providerCount: Object.keys(providers).length,
  modelCount,
  providers,
};

await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(document)}\n`, 'utf8');
console.log(`wrote ${Object.keys(providers).length} providers / ${modelCount} models -> ${target}`);

function leanModel(model) {
  if (!model || typeof model !== 'object' || !model.id) return null;
  const limit = model.limit || {};
  const effort = (Array.isArray(model.reasoning_options) ? model.reasoning_options : [])
    .find((option) => option && option.type === 'effort');
  const input = (model.modalities && Array.isArray(model.modalities.input)) ? model.modalities.input : [];
  const entry = {
    ...(text(model.name) ? { name: text(model.name) } : {}),
    ...(positive(limit.context) ? { c: positive(limit.context) } : {}),
    ...(positive(limit.output) ? { o: positive(limit.output) } : {}),
    ...(model.reasoning === true ? { r: true } : {}),
    ...(Array.isArray(effort?.values) && effort.values.length ? { eff: effort.values.map(text).filter(Boolean) } : {}),
    ...(model.tool_call === true ? { t: true } : {}),
    ...(input.includes('image') ? { img: true } : {}),
  };
  return Object.keys(entry).length ? entry : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
