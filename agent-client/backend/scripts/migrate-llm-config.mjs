/**
 * One-shot migration from the flat `llm.json` array to the v2 provider document.
 *
 * The runtime already reads both shapes, so this script is optional: it exists to make
 * the change explicit and to leave a backup behind, not because the server needs it to
 * boot. Running it twice is a no-op.
 *
 *   node scripts/migrate-llm-config.mjs            # migrate and write
 *   node scripts/migrate-llm-config.mjs --dry-run  # print the target document only
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configDir = process.env.BIOFLOW_CONFIG_DIR
  ? path.resolve(process.env.BIOFLOW_CONFIG_DIR)
  : path.join(root, 'config');
const target = path.join(configDir, 'llm.json');
const backup = path.join(configDir, 'llm.json.v1.bak');
const dryRun = process.argv.includes('--dry-run');

const raw = JSON.parse(stripBom(await readFile(target, 'utf8')));
if (raw && !Array.isArray(raw) && raw.schemaVersion === 2) {
  console.log('llm.json is already schemaVersion 2 — nothing to do.');
  process.exit(0);
}

const items = Array.isArray(raw) ? raw : Array.isArray(raw?.providers) ? raw.providers : [];
const providers = items.map(toProvider);
const explicitDefault = items.find((item) => item?.isDefault === true);
const document = {
  schemaVersion: 2,
  ...(explicitDefault?.id || providers[0]?.id ? { defaultProviderId: String(explicitDefault?.id || providers[0].id) } : {}),
  providers,
};

if (dryRun) {
  console.log(JSON.stringify(document, null, 2));
  process.exit(0);
}

await copyFile(target, backup);
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`migrated ${providers.length} provider(s); previous file saved as ${path.basename(backup)}`);

function toProvider(value) {
  const id = text(value?.id);
  const model = text(value?.model);
  const contextWindowTokens = positiveInteger(value?.contextWindowTokens ?? value?.context_window_tokens);
  // Before the split, the level *was* the wire value, so the identity map reproduces
  // today's behaviour exactly. Rename a level here only to change what is sent.
  const thinkingLevel = text(value?.thinkingLevel ?? value?.thinking_level);
  const createdAt = text(value?.createdAt) || new Date().toISOString();
  return {
    id,
    presetId: text(value?.presetId) || 'custom',
    name: text(value?.name) || id,
    baseUrl: text(value?.baseUrl ?? value?.base_url),
    apiKey: text(value?.apiKey ?? value?.api_key),
    thinkingFormat: 'openai-effort',
    ...(model ? { defaultModelId: model } : {}),
    models: model
      ? [{
        id: model,
        label: model,
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
        ...(thinkingLevel ? { reasoningEfforts: { [thinkingLevel]: thinkingLevel }, defaultThinkingLevel: thinkingLevel } : {}),
        metadataSource: 'manual',
        updatedAt: text(value?.updatedAt) || createdAt,
      }]
      : [],
    createdAt,
    updatedAt: text(value?.updatedAt) || createdAt,
  };
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, '');
}

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
