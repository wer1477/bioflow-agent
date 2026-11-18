import fs from 'node:fs';
import path from 'node:path';
import { ensureTeamRoles } from './agent_config_store.js';
import { CONFIG_ROOT } from '../../paths.js';

/**
 * `llm_presets.json` is deliberately absent. It is an optional overlay: an unreadable overlay
 * degrades to the raw catalog at runtime (see `llm_catalog.ts`), and `test/llm_presets.test.ts`
 * validates the shipped file against the catalog. A hand-edited typo must not stop the server
 * from starting — the settings page stays usable and the next test run reports the mistake.
 */
const CONFIG_FILES = ['agents.json', 'llm.json', 'mcp.json', 'prompts.json'];

export interface BackendConfigLoadResult {
  configDir: string;
  loaded: string[];
  skipped: string[];
}

/**
 * Configuration files are the source of truth. Loading validates JSON files
 * and lets the file-backed stores read them on demand; no database projection
 * or persistence pass is required.
 */
export function loadBackendConfig(configDir = process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT): BackendConfigLoadResult {
  const resolvedConfigDir = path.resolve(configDir);
  const result: BackendConfigLoadResult = { configDir: resolvedConfigDir, loaded: [], skipped: [] };
  if (!fs.existsSync(resolvedConfigDir)) return result;

  for (const fileName of CONFIG_FILES) {
    const filePath = path.join(resolvedConfigDir, fileName);
    if (!fs.existsSync(filePath)) {
      result.skipped.push(fileName);
      continue;
    }
    if (fileName.endsWith('.json')) JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    result.loaded.push(fileName);
  }

  // Also creates the five team roles when the config directory is empty, and migrates a
  // single-agent `agents.json` in place (see `ensureTeamRoles`).
  ensureTeamRoles();
  return result;
}
