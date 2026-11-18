import fs from 'node:fs';
import path from 'node:path';
import { findSessionProjectKey } from '../config/conversation_file_store.js';
import { sessionDirectory } from '../config/session_paths.js';
import { getAgentRun, updateAgentRun, type AgentRun } from '../config/run_store.js';
import { resolveConversationProjectPath } from '../project_boundary.js';
import { getTranscriptEventsPath } from '../transcript_store.js';
import { readTranscript, type TranscriptRecord } from '../transcript_reader.js';
import { captureEnvironmentSnapshot, type EnvironmentSnapshot } from './environment_snapshot.js';
import { hashFile, hashText, stableStringify } from './file_hash.js';

/**
 * Per-run provenance manifest.
 *
 * The transcript already records every tool call and its parameters, and tool results
 * carry the files they produced. What was missing is the join: a single document that
 * says which code version, which environment, which parameters and which artifact
 * hashes belong to one run. This module builds that document at run end, writes it
 * next to the session state, and never lets a provenance failure affect the run.
 */

export interface ManifestToolCall {
  name: string;
  callId: string;
  turnIndex: number | null;
  startedAt: string;
  durationMs?: number;
  isError?: boolean;
  /** Parsed arguments, truncated to keep the manifest readable. The hash covers the full value. */
  arguments?: Record<string, unknown>;
  argumentsSha256: string;
  resultSha256?: string;
  producedFiles?: string[];
}

export interface ManifestArtifact {
  path: string;
  absolutePath: string;
  bytes: number;
  sha256: string | null;
  skipped?: string;
  mimeType: string;
  source: 'tool_output' | 'artifact_event' | 'project_scan';
}

export interface RunManifest {
  schemaVersion: 1;
  generatedAt: string;
  run: {
    id: string;
    conversationId: string;
    agentId: string | null;
    status: string;
    stopReason: string | null;
    startedAt: string;
    completedAt: string | null;
  };
  code: EnvironmentSnapshot['code'];
  environment: Omit<EnvironmentSnapshot, 'code'>;
  transcript: { path: string; bytes: number; sha256: string | null; events: number } | null;
  tools: ManifestToolCall[];
  artifacts: ManifestArtifact[];
  inputs: [];
  warnings: string[];
}

export interface BuildManifestInput {
  conversationId: string;
  run: AgentRun;
  records: TranscriptRecord[];
  environment: EnvironmentSnapshot;
  projectPath?: string | null;
  transcriptPath?: string | null;
  scanProject?: boolean;
  warnings?: string[];
}

export interface FinalizeOptions {
  conversationId: string;
  runId: string;
  /** Injection point for tests; production always captures the live environment. */
  environment?: EnvironmentSnapshot;
  scanProject?: boolean;
}

interface ArtifactLimits {
  maxArtifacts: number;
  maxScanFiles: number;
  maxScanArtifacts: number;
  maxDepth: number;
  maxHashBytes: number;
}

const DEFAULT_LIMITS: ArtifactLimits = {
  maxArtifacts: 500,
  maxScanFiles: 20_000,
  maxScanArtifacts: 200,
  maxDepth: 6,
  maxHashBytes: 256 * 1024 * 1024,
};

const SCANNED_DIRECTORY_DENYLIST = new Set([
  '.git',
  'node_modules',
  '.cache',
  '.bioenv',
  '.tools',
  '.Rlib',
  '__pycache__',
  'site-packages',
  'venv',
  '.venv',
  'env',
  'envs',
  'tools',
  'db',
  'reference',
  'star_idx',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.h5ad': 'application/x-hdf5',
  '.h5': 'application/x-hdf5',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.bam': 'application/octet-stream',
  '.vcf': 'text/vcf',
  '.nwk': 'text/plain',
  '.narrowPeak': 'text/plain',
};

const inflight = new Map<string, Promise<string | null>>();

/**
 * Build and persist the manifest for one finished run.
 *
 * Callers use `void finalizeRunManifest(...)`; the returned promise exists for tests and
 * for callers that want to await the write. Every failure is swallowed after being
 * recorded, because provenance is observability, not a gate on the answer.
 */
export function finalizeRunManifest(options: FinalizeOptions): Promise<string | null> {
  const key = `${options.conversationId}:${options.runId}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = writeManifestForRun(options)
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Test seam: wait for every manifest write started so far. */
export async function awaitManifestWrites(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.all([...inflight.values()]);
  }
}

async function writeManifestForRun(options: FinalizeOptions): Promise<string | null> {
  // Capture (or reuse) the environment before reading the run record. The await lets
  // a synchronous `cancel()` finish its status update first, so a cancelled run is not
  // recorded as the `failed` state it passed through.
  const environment = options.environment ?? (await captureEnvironmentSnapshot());
  const run = getAgentRun(options.conversationId, options.runId);
  if (!run) return null;
  const metadata = (run.metadata || {}) as Record<string, unknown>;
  if (typeof metadata.manifestPath === 'string' && fs.existsSync(metadata.manifestPath)) {
    return metadata.manifestPath;
  }

  const target = manifestPathForRun(options.conversationId, options.runId);
  if (!target) return null;

  const warnings: string[] = [];
  const records = readRunRecords(options.conversationId, options.runId, warnings);
  const transcriptPath = safeTranscriptPath(options.conversationId);
  if (!transcriptPath) warnings.push('transcript path unavailable');
  const transcriptStat = transcriptPath ? await hashFile(transcriptPath) : null;
  const projectPath = resolveConversationProjectPath(options.conversationId);

  const manifest = await buildRunManifest({
    conversationId: options.conversationId,
    run,
    records,
    environment,
    projectPath,
    transcriptPath,
    scanProject: options.scanProject,
    warnings,
  });
  if (transcriptStat) {
    manifest.transcript = {
      path: transcriptPath as string,
      bytes: transcriptStat.bytes,
      sha256: transcriptStat.sha256,
      events: records.length,
    };
  }

  writeJsonAtomic(target, manifest);
  const latest = getAgentRun(options.conversationId, options.runId);
  updateAgentRun(options.conversationId, options.runId, {
    metadata: { ...((latest?.metadata as Record<string, unknown>) || {}), manifestPath: target },
  });
  return target;
}

export async function buildRunManifest(input: BuildManifestInput): Promise<RunManifest> {
  const warnings = [...(input.warnings || [])];
  const { tools, produced } = foldToolCalls(input.records, warnings);
  const artifacts = await collectArtifacts({
    produced,
    projectPath: input.projectPath || null,
    sinceMs: Date.parse(input.run.startedAt),
    scanProject: input.scanProject,
    warnings,
  });
  const { code, ...environment } = input.environment;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    run: {
      id: input.run.id,
      conversationId: input.conversationId,
      agentId: input.run.agentId || null,
      status: input.run.status,
      stopReason: input.run.stopReason,
      startedAt: input.run.startedAt,
      completedAt: input.run.completedAt,
    },
    code,
    environment,
    transcript: null,
    tools,
    artifacts,
    inputs: [],
    warnings: [...new Set(warnings)],
  };
}

export function manifestPathForRun(conversationId: string, runId: string): string | null {
  if (!conversationId || !runId) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  const projectKey = findSessionProjectKey(conversationId);
  if (!projectKey) return null;
  return path.join(sessionDirectory(projectKey, conversationId), 'runs', runId, 'manifest.json');
}

export async function readRunManifest(conversationId: string, runId: string): Promise<RunManifest | null> {
  const target = manifestPathForRun(conversationId, runId);
  if (!target || !fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8')) as RunManifest;
  } catch {
    return null;
  }
}

export function renderRunManifestMarkdown(manifest: RunManifest): string {
  const lines: string[] = [];
  lines.push('# Run manifest', '');
  lines.push(`- Run: \`${manifest.run.id}\``);
  lines.push(`- Conversation: \`${manifest.run.conversationId}\``);
  lines.push(`- Agent: ${manifest.run.agentId || 'n/a'}`);
  lines.push(`- Status: ${manifest.run.status}${manifest.run.stopReason ? ` (${manifest.run.stopReason})` : ''}`);
  lines.push(`- Started: ${manifest.run.startedAt}`);
  lines.push(`- Completed: ${manifest.run.completedAt || 'n/a'}`);
  lines.push('', '## Code', '');
  lines.push(`- Repository: \`${manifest.code.repositoryRoot}\``);
  lines.push(`- Commit: \`${manifest.code.commit || 'unavailable'}\`${manifest.code.dirty ? ' (dirty working tree)' : ''}`);
  lines.push(`- Branch: ${manifest.code.branch || 'n/a'}`);
  lines.push('', '## Environment', '');
  lines.push(`- Host: ${manifest.environment.host} (${manifest.environment.platform})`);
  lines.push(`- Node: ${manifest.environment.node}`);
  if (manifest.environment.python) {
    lines.push(`- Python: ${manifest.environment.python.version || 'unknown'} (\`${manifest.environment.python.executable}\`)`);
    for (const [name, version] of Object.entries(manifest.environment.python.packages).sort()) {
      lines.push(`  - ${name} ${version}`);
    }
  } else {
    lines.push('- Python: unavailable');
  }
  if (manifest.environment.r) {
    lines.push(`- R: ${manifest.environment.r.version || 'unknown'} (\`${manifest.environment.r.executable}\`)`);
    for (const [name, version] of Object.entries(manifest.environment.r.packages).sort()) {
      lines.push(`  - ${name} ${version}`);
    }
  }
  lines.push('', `## Tools (${manifest.tools.length})`, '');
  if (manifest.tools.length) {
    lines.push('| # | tool | duration | args sha256 | error |', '|---|---|---|---|---|');
    manifest.tools.forEach((tool, index) => {
      lines.push(
        `| ${index + 1} | ${tool.name} | ${tool.durationMs ?? '-'} ms | \`${tool.argumentsSha256.slice(0, 12)}\` | ${tool.isError ? 'yes' : 'no'} |`,
      );
    });
  } else {
    lines.push('No tool calls recorded.');
  }
  lines.push('', `## Artifacts (${manifest.artifacts.length})`, '');
  if (manifest.artifacts.length) {
    lines.push('| path | bytes | sha256 | source |', '|---|---|---|---|');
    for (const artifact of manifest.artifacts) {
      lines.push(`| \`${artifact.path}\` | ${artifact.bytes} | \`${artifact.sha256 || artifact.skipped || 'n/a'}\` | ${artifact.source} |`);
    }
  } else {
    lines.push('No artifacts recorded.');
  }
  if (manifest.warnings.length) {
    lines.push('', '## Warnings', '');
    for (const warning of manifest.warnings) lines.push(`- ${warning}`);
  }
  lines.push('', '## Reproduce', '');
  lines.push('```bash');
  lines.push(`git checkout ${manifest.code.commit || '<commit unavailable>'}`);
  lines.push(`cd ${manifest.code.repositoryRoot}`);
  lines.push('scripts/activate-bioenv.sh');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function readRunRecords(conversationId: string, runId: string, warnings: string[]): TranscriptRecord[] {
  try {
    return readTranscript(conversationId, { runId, unlimited: true }).events;
  } catch (error) {
    warnings.push(`transcript unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function safeTranscriptPath(conversationId: string): string | null {
  try {
    return getTranscriptEventsPath(conversationId);
  } catch {
    return null;
  }
}

interface FoldedToolCalls {
  tools: ManifestToolCall[];
  produced: Array<{ absolutePath: string; source: ManifestArtifact['source'] }>;
}

function foldToolCalls(records: TranscriptRecord[], warnings: string[]): FoldedToolCalls {
  const calls = new Map<string, ManifestToolCall>();
  const order: string[] = [];
  for (const record of records) {
    if (record.type !== 'tool_call') continue;
    const callId = String(record.data.callId || '');
    if (!callId) continue;
    const parsedArguments = (record.data.parsedArguments || {}) as Record<string, unknown>;
    const call: ManifestToolCall = {
      name: String(record.data.toolName || 'unknown'),
      callId,
      turnIndex: typeof record.data.turnIndex === 'number' ? record.data.turnIndex : null,
      startedAt: record.createdAt,
      arguments: truncateArguments(parsedArguments),
      argumentsSha256: hashText(stableStringify(parsedArguments)),
    };
    calls.set(callId, call);
    order.push(callId);
  }

  const produced: Array<{ absolutePath: string; source: ManifestArtifact['source'] }> = [];
  for (const record of records) {
    if (record.type !== 'tool_result') continue;
    const callId = String(record.data.callId || '');
    const call = calls.get(callId);
    if (!call) {
      warnings.push(`tool result without a matching call: ${callId || 'unknown'}`);
      continue;
    }
    const rawResult = record.data.rawResult as { sha256?: unknown } | undefined;
    if (rawResult && typeof rawResult.sha256 === 'string') call.resultSha256 = rawResult.sha256;
    if (typeof record.data.durationMs === 'number') call.durationMs = record.data.durationMs;
    if (typeof record.data.isError === 'boolean') call.isError = record.data.isError;
    const files = Array.isArray(record.data.producedFiles)
      ? record.data.producedFiles.filter((value): value is string => typeof value === 'string')
      : [];
    if (files.length) call.producedFiles = files;
    for (const file of files) produced.push({ absolutePath: file, source: 'tool_output' });
    const observation = record.data.observation as { artifact?: { path?: unknown } } | undefined;
    const artifactPath = observation?.artifact?.path;
    if (typeof artifactPath === 'string' && artifactPath) {
      produced.push({ absolutePath: artifactPath, source: 'artifact_event' });
    }
  }
  return { tools: order.map((callId) => calls.get(callId) as ManifestToolCall), produced };
}

function truncateArguments(arguments_: Record<string, unknown>): Record<string, unknown> | undefined {
  const serialized = JSON.stringify(arguments_);
  if (!serialized || serialized === '{}') return undefined;
  const maxChars = 4000;
  if (serialized.length <= maxChars) return arguments_;
  return { _truncated: true, preview: serialized.slice(0, maxChars) };
}

interface CollectArtifactsInput {
  produced: Array<{ absolutePath: string; source: ManifestArtifact['source'] }>;
  projectPath: string | null;
  sinceMs: number;
  scanProject?: boolean;
  warnings: string[];
}

async function collectArtifacts(input: CollectArtifactsInput): Promise<ManifestArtifact[]> {
  const limits = DEFAULT_LIMITS;
  const byAbsolutePath = new Map<string, ManifestArtifact['source']>();
  for (const { absolutePath, source } of input.produced) {
    const resolved = resolveArtifactPath(absolutePath, input.projectPath);
    if (resolved) byAbsolutePath.set(resolved, source);
  }

  const scanEnabled = input.scanProject ?? process.env.BIOFLOW_MANIFEST_SCAN !== '0';
  if (scanEnabled && input.projectPath) {
    const scanned = await scanProjectArtifacts(input.projectPath, input.sinceMs, limits, input.warnings);
    for (const absolutePath of scanned) {
      if (!byAbsolutePath.has(absolutePath)) byAbsolutePath.set(absolutePath, 'project_scan');
    }
  }

  const entries = [...byAbsolutePath.entries()].slice(0, limits.maxArtifacts);
  if (byAbsolutePath.size > entries.length) {
    input.warnings.push(`artifact list truncated to ${limits.maxArtifacts} entries`);
  }
  const artifacts = await mapWithConcurrency(entries, 4, async ([absolutePath, source]) => {
    const digest = await hashFile(absolutePath, limits.maxHashBytes);
    return {
      path: displayPath(absolutePath, input.projectPath),
      absolutePath,
      bytes: digest.bytes,
      sha256: digest.sha256,
      ...(digest.skipped ? { skipped: digest.skipped } : {}),
      mimeType: mimeTypeFor(absolutePath),
      source,
    } satisfies ManifestArtifact;
  });
  return artifacts;
}

function resolveArtifactPath(candidate: string, projectPath: string | null): string | null {
  if (!candidate) return null;
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : projectPath
      ? path.resolve(projectPath, candidate)
      : null;
  if (!absolute) return null;
  try {
    return fs.realpathSync(absolute);
  } catch {
    return null;
  }
}

function displayPath(absolutePath: string, projectPath: string | null): string {
  if (!projectPath) return absolutePath;
  const root = fs.existsSync(projectPath) ? fs.realpathSync(projectPath) : path.resolve(projectPath);
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return absolutePath;
  return relative;
}

function mimeTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[extension] || 'application/octet-stream';
}

async function scanProjectArtifacts(
  projectPath: string,
  sinceMs: number,
  limits: ArtifactLimits,
  warnings: string[],
): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  let capped = false;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (capped || depth > limits.maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (capped) return;
      visited += 1;
      if (visited > limits.maxScanFiles) {
        capped = true;
        warnings.push(`project scan stopped after ${limits.maxScanFiles} entries`);
        return;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SCANNED_DIRECTORY_DENYLIST.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(full);
        if (Number.isFinite(sinceMs) && stat.mtimeMs < sinceMs - 1000) continue;
        if (stat.size > limits.maxHashBytes) continue;
        found.push(full);
        if (found.length >= limits.maxScanArtifacts) {
          capped = true;
          warnings.push(`project scan limited to ${limits.maxScanArtifacts} artifacts`);
          return;
        }
      } catch {
        // A file that vanished mid-scan is not an error.
      }
    }
  };

  await walk(projectPath, 0);
  return found;
}

function writeJsonAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
}
