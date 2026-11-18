import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Per-project Python environments.
 *
 * The deployment ships one read-only shared environment (`BIOAGENT_ENV_BIN`).
 * A project only gets a writable venv when it needs packages the shared
 * environment does not carry. The venv is created with
 * `--system-site-packages`, so the shared packages stay visible while
 * `pip`/`uv` installs land inside `<project>/.venv` only.
 *
 * This is deliberately best-effort: when the base environment or `venv` is
 * missing, callers fall back to the shared interpreter instead of failing the
 * whole turn. Enforcement still stops `pip` from writing the shared
 * user-site, but an `unrestricted` shell can always override environment
 * variables; this is a default-safe boundary, not a security sandbox.
 */
const ENABLED_PATTERN = /^(1|true|yes|on)$/i;
const VENV_DIRECTORY = '.venv';
const R_LIBRARY_DIRECTORY = '.Rlib';
const CREATE_TIMEOUT_MS = 120_000;
const CREATE_MAX_BUFFER = 4 * 1024 * 1024;
const inFlight = new Map<string, Promise<string | null>>();
let warnedMissingBase = false;

export function projectVenvEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_PATTERN.test(String(environment.BIOFLOW_PROJECT_VENV || '').trim());
}

export function projectVenvPath(projectPath: string): string {
  return path.join(path.resolve(projectPath), VENV_DIRECTORY);
}

function venvBinDirectory(venv: string): string {
  return path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
}

export function projectVenvBinPath(projectPath: string): string {
  return venvBinDirectory(projectVenvPath(projectPath));
}

export function projectVenvPythonPath(projectPath: string): string {
  return path.join(venvBinDirectory(projectVenvPath(projectPath)), process.platform === 'win32' ? 'python.exe' : 'python');
}

export function projectRLibraryPath(projectPath: string): string {
  return path.join(path.resolve(projectPath), R_LIBRARY_DIRECTORY);
}

/** Base interpreter from `BIOAGENT_ENV_BIN`, or null when the shared env is missing. */
export function basePythonPath(environment: NodeJS.ProcessEnv = process.env): string | null {
  const bin = String(environment.BIOAGENT_ENV_BIN || '').trim();
  if (!bin) return null;
  const candidate = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Environment variables that pin child processes to the project venv. Empty
 * when the feature is off or the venv has not been created yet, so callers can
 * keep working with the shared environment.
 */
export function projectVenvEnvironment(projectPath: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!projectVenvEnabled(environment)) return {};
  if (!fs.existsSync(projectVenvPythonPath(projectPath))) return {};
  return {
    VIRTUAL_ENV: projectVenvPath(projectPath),
    PYTHONNOUSERSITE: '1',
    PIP_REQUIRE_VIRTUALENV: 'true',
    PIP_USER: '0',
    UV_PROJECT_ENVIRONMENT: projectVenvPath(projectPath),
    R_LIBS_USER: projectRLibraryPath(projectPath),
  };
}

/** Create `<project>/.venv` once, sharing one creation promise per project. */
export async function ensureProjectVenv(projectPath: string, environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!projectVenvEnabled(environment)) return null;
  const root = path.resolve(projectPath);
  const venv = projectVenvPath(root);
  const python = projectVenvPythonPath(root);
  if (fs.existsSync(python)) return venv;

  const basePython = basePythonPath(environment);
  if (!basePython) {
    if (!warnedMissingBase) {
      console.warn('[project-venv] BIOAGENT_ENV_BIN is not configured; keeping the shared interpreter.');
      warnedMissingBase = true;
    }
    return null;
  }

  try {
    fs.mkdirSync(projectRLibraryPath(root), { recursive: true });
  } catch (error) {
    console.warn(`[project-venv] unable to create the project R library: ${errorMessage(error)}`);
  }

  const pending = inFlight.get(venv);
  if (pending) return pending;
  const creation = createProjectVenv(basePython, root, venv).finally(() => inFlight.delete(venv));
  inFlight.set(venv, creation);
  return creation;
}

async function createProjectVenv(basePython: string, projectPath: string, venv: string): Promise<string | null> {
  try {
    const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONNOUSERSITE: '1' };
    // Nested venvs are not supported: create this one from the shared base.
    delete environment.VIRTUAL_ENV;
    delete environment.CONDA_PREFIX;
    await execFileAsync(basePython, ['-m', 'venv', '--clear', '--system-site-packages', venv], {
      cwd: projectPath,
      env: environment,
      timeout: CREATE_TIMEOUT_MS,
      maxBuffer: CREATE_MAX_BUFFER,
    });
    if (!fs.existsSync(projectVenvPythonPath(projectPath))) {
      console.warn(`[project-venv] ${venv} was created without a Python executable.`);
      return null;
    }
    return venv;
  } catch (error) {
    console.warn(`[project-venv] unable to create ${venv}: ${errorMessage(error)}`);
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
