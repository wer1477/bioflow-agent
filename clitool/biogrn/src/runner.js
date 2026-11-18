import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/infer.py', import.meta.url));

export class InferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function runInference(request, { python = process.env.BIOAGENT_PYTHON || 'python3' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT_PATH], {
      cwd: path.dirname(request.expression_path),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Arboreto 0.1.6 builds its dask graph with `from_delayed`, which raises
      // "Must supply at least one delayed object" under dask's expr query
      // planner. The legacy dataframe backend is required for GRNBoost2/GENIE3
      // inference, so opt out only for this child process.
      env: { ...process.env, DASK_DATAFRAME__QUERY_PLANNING: 'false' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      reject(new InferenceError('dependency-unavailable', `Cannot start Python interpreter ${python}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `Arboreto inference exited with code ${code}.`;
        const dependencyMissing = /No module named ['"][^'"]+['"]/.test(message);
        reject(new InferenceError(dependencyMissing ? 'dependency-unavailable' : 'inference-failed', dependencyMissing
          ? 'Required Python analysis dependencies are unavailable in the selected interpreter. Install the repository analysis dependencies (including Arboreto) and retry.'
          : message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new InferenceError('inference-failed', `Inference returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
