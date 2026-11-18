import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPOSITORY_ROOT } from '../../paths.js';

/**
 * Machine-readable description of the stack that produced a run.
 *
 * This is the "code version + environment" half of the run manifest. It is captured
 * once per run (with a short process-level cache) and is deliberately fail-open:
 * a missing `git`, python or R leaves a `null` field plus a warning, because a run
 * must never fail just because the provenance probe did.
 */

export interface CodeSnapshot {
  repositoryRoot: string;
  available: boolean;
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
}

export interface LanguageSnapshot {
  executable: string;
  version: string | null;
  packages: Record<string, string>;
}

export interface EnvironmentSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  host: string;
  platform: string;
  node: string;
  code: CodeSnapshot;
  python: LanguageSnapshot | null;
  r: LanguageSnapshot | null;
  warnings: string[];
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number; cwd?: string },
) => Promise<CommandResult>;

export interface CaptureOptions {
  repositoryRoot?: string;
  envBin?: string;
  runner?: CommandRunner;
  timeoutMs?: number;
  /** Bypass the process cache. */
  fresh?: boolean;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 2000;

const PYTHON_PACKAGES = [
  'numpy',
  'pandas',
  'anndata',
  'scanpy',
  'pysam',
  'cyvcf2',
  'gseapy',
  'pydeseq2',
  'seaborn',
  'scikit-learn',
  'matplotlib',
  'umap-learn',
];

const R_PACKAGES = ['DESeq2', 'edgeR', 'limma', 'data.table'];

let cachedSnapshot: { snapshot: EnvironmentSnapshot; expiresAt: number } | null = null;

export function resetEnvironmentSnapshotCache(): void {
  cachedSnapshot = null;
}

export const defaultCommandRunner: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error ? { error: error.message } : {}),
        });
      },
    );
  });

export async function captureEnvironmentSnapshot(options: CaptureOptions = {}): Promise<EnvironmentSnapshot> {
  if (!options.fresh && cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) {
    return cachedSnapshot.snapshot;
  }
  const snapshot = await buildEnvironmentSnapshot(options);
  cachedSnapshot = { snapshot, expiresAt: Date.now() + CACHE_TTL_MS };
  return snapshot;
}

async function buildEnvironmentSnapshot(options: CaptureOptions): Promise<EnvironmentSnapshot> {
  const repositoryRoot = path.resolve(options.repositoryRoot || REPOSITORY_ROOT);
  const envBin = options.envBin || process.env.BIOAGENT_ENV_BIN || path.join(repositoryRoot, '.bioenv', 'bin');
  const runner = options.runner || defaultCommandRunner;
  const warnings: string[] = [];

  const code = await captureCode(repositoryRoot, runner, warnings);
  const [python, r] = await Promise.all([
    capturePython(envBin, runner, options.timeoutMs, warnings),
    captureR(envBin, runner, options.timeoutMs, warnings),
  ]);

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    host: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    code,
    python,
    r,
    warnings,
  };
}

async function captureCode(repositoryRoot: string, runner: CommandRunner, warnings: string[]): Promise<CodeSnapshot> {
  const base: CodeSnapshot = { repositoryRoot, available: false, commit: null, branch: null, dirty: null };
  if (!fs.existsSync(path.join(repositoryRoot, '.git'))) {
    warnings.push('code version unavailable: not a git checkout');
    return base;
  }
  const [commitResult, branchResult, statusResult] = await Promise.all([
    runner('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }),
    runner('git', ['-C', repositoryRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }),
    // `--untracked-files=no` keeps the probe independent of workspace churn under
    // ignored paths (workspace/, data/, .bioenv/), which is not source state.
    runner('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=no'], { timeoutMs: GIT_TIMEOUT_MS }),
  ]);
  const commit = commitResult.ok ? commitResult.stdout.trim() : '';
  const branch = branchResult.ok ? branchResult.stdout.trim() : '';
  if (!commit) {
    warnings.push('code version unavailable: git rev-parse failed');
    return base;
  }
  return {
    repositoryRoot,
    available: true,
    commit,
    branch: branch || null,
    dirty: statusResult.ok ? statusResult.stdout.trim().length > 0 : null,
  };
}

async function capturePython(
  envBin: string,
  runner: CommandRunner,
  timeoutMs: number | undefined,
  warnings: string[],
): Promise<LanguageSnapshot | null> {
  const executable =
    process.env.BIOAGENT_PYTHON ||
    path.join(envBin, process.platform === 'win32' ? 'python.exe' : 'python');
  if (!fs.existsSync(executable)) {
    warnings.push(`python environment not found at ${executable}`);
    return null;
  }
  const script = [
    'import json, sys',
    'from importlib import metadata',
    `names = ${JSON.stringify(PYTHON_PACKAGES)}`,
    'out = {"version": "%d.%d.%d" % sys.version_info[:3], "packages": {}}',
    'for name in names:',
    '    try: out["packages"][name] = metadata.version(name)',
    '    except Exception: pass',
    'print(json.dumps(out))',
  ].join('\n');
  const result = await runner(executable, ['-c', script], { timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (!result.ok) {
    warnings.push(`python probe failed: ${result.error || result.stderr.trim() || 'unknown error'}`);
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { version?: unknown; packages?: unknown };
    const packages: Record<string, string> = {};
    if (parsed.packages && typeof parsed.packages === 'object') {
      for (const [name, version] of Object.entries(parsed.packages as Record<string, unknown>)) {
        if (typeof version === 'string') packages[name] = version;
      }
    }
    return { executable, version: typeof parsed.version === 'string' ? parsed.version : null, packages };
  } catch {
    warnings.push('python probe returned unparseable output');
    return null;
  }
}

async function captureR(
  envBin: string,
  runner: CommandRunner,
  timeoutMs: number | undefined,
  warnings: string[],
): Promise<LanguageSnapshot | null> {
  const executable = path.join(envBin, process.platform === 'win32' ? 'Rscript.exe' : 'Rscript');
  if (!fs.existsSync(executable)) {
    warnings.push(`R environment not found at ${executable}`);
    return null;
  }
  const script = [
    'cat(sprintf("version\\t%s\\n", paste(R.version$major, R.version$minor, sep=".")))',
    `for (p in ${toRLiteral(R_PACKAGES)}) {`,
    '  v <- tryCatch(as.character(packageVersion(p)), error=function(e) NA_character_)',
    '  if (!is.na(v)) cat(sprintf("package\\t%s\\t%s\\n", p, v))',
    '}',
  ].join('\n');
  const result = await runner(executable, ['-e', script], { timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (!result.ok) {
    warnings.push(`R probe failed: ${result.error || result.stderr.trim() || 'unknown error'}`);
    return null;
  }
  let version: string | null = null;
  const packages: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const fields = line.trim().split('\t');
    if (fields[0] === 'version' && fields[1]) version = fields[1];
    if (fields[0] === 'package' && fields[1] && fields[2]) packages[fields[1]] = fields[2];
  }
  return { executable, version, packages };
}

function toRLiteral(values: string[]): string {
  return `c(${values.map((value) => JSON.stringify(value)).join(', ')})`;
}
