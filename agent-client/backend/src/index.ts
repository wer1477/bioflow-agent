import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Load the env file *before* importing anything that resolves module roots.
 *
 * `paths.ts` freezes `WORKSPACE_ROOT` (and friends) at import time, and the old
 * entrypoint imported `environment_file_store.ts` to locate `.env` — which pulled
 * `paths.ts` in first, so `BIOFLOW_WORKSPACE_DIR` from `.env` arrived too late and a
 * relocated deployment silently fell back to the in-repo `agent-client/workspace`.
 * Everything that reads env at module scope must therefore be a dynamic import below.
 */
// `src/index.ts` and `dist/index.js` both sit one level below `backend/`.
const defaultEnvFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
loadDotenv({ path: path.resolve(process.env.BIOFLOW_ENV_FILE || defaultEnvFile) });

const { configureBioagentRuntimeEnvironment } = await import('./runtime_environment.js');
configureBioagentRuntimeEnvironment(process.env);

const { startHttpServer } = await import('./http/server.js');
await startHttpServer();
