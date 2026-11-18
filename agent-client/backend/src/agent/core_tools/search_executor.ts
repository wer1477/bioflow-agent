import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CoreToolExecutionContext } from '../core_tools_runtime.js';
import { resolveToolRoot } from './project_paths.js';
import { CoreToolExecutionAbortedError, clampNumber, resolveTerminalPath, toolProcessEnvironment } from './shared.js';

const DEFAULT_SEARCH_EXCLUDES = ['!.git/**', '!node_modules/**'];
const MAX_RIPGREP_RECORD_CHARS = 64 * 1024;
/** Hard ceiling for parsed ripgrep JSON events (used by `count` mode, which does not page early). */
const MAX_GREP_EVENTS = 200_000;
const DEFAULT_GREP_HEAD_LIMIT = 100;
const MAX_GREP_HEAD_LIMIT = 2_000;
const MAX_GREP_CONTEXT = 10;
const MAX_PREVIEW_CHARS = 2_000;

export type GrepOutputMode = 'content' | 'files' | 'count';

export interface GrepContextLine {
  line: number;
  preview: string;
}

export interface GrepMatchRecord {
  path: string;
  line: number;
  preview: string;
  context?: { before: GrepContextLine[]; after: GrepContextLine[] };
}

/** Normalized `grep` arguments, after clamping and legacy aliasing. */
export interface GrepOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  include?: string[];
  exclude?: string[];
  type?: string;
  context: number;
  headLimit: number;
  offset: number;
  outputMode: GrepOutputMode;
}

export interface GrepCollectorOptions {
  outputMode: GrepOutputMode;
  context: number;
  headLimit: number;
  offset: number;
}

interface RipgrepEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

export async function executeGlob(args: Record<string, unknown>, context: CoreToolExecutionContext): Promise<Record<string, unknown>> {
  const abortSignal = context.abortSignal;
  const root = resolveTerminalPath(args.path, resolveToolRoot(context));
  const searchLocation = resolveSearchLocation(root);
  const pattern = String(args.pattern || '').trim();
  if (!pattern) throw new Error('glob requires pattern.');
  const matches: string[] = [];
  await runRipgrep(['--files', '--hidden', ...searchGlobArgs(pattern, toStringArray(args.include), toStringArray(args.exclude)), searchLocation.target], searchLocation.cwd, resolveToolRoot(context), (line, stop) => {
    matches.push(normalizeSearchPath(line));
    if (matches.length >= clampNumber(args.max_results, 100, 1, 2_000)) stop();
  }, abortSignal);
  return { ok: true, path: root, pattern, count: matches.length, matches };
}


export async function executeGrep(args: Record<string, unknown>, context: CoreToolExecutionContext): Promise<Record<string, unknown>> {
  const abortSignal = context.abortSignal;
  const root = resolveTerminalPath(args.path, resolveToolRoot(context));
  const searchLocation = resolveSearchLocation(root);
  const options = parseGrepOptions(args);
  if (!options.query) throw new Error('grep requires query.');
  const command = buildGrepArguments(options, searchLocation.target);
  const collector = new GrepEventCollector(options);
  await runRipgrep(command, searchLocation.cwd, resolveToolRoot(context), (line, stop) => {
    const event = parseRipgrepEvent(line);
    if (!event) return;
    collector.push(event);
    if (collector.shouldStop()) stop();
  }, abortSignal);
  return { ok: true, path: root, query: options.query, ...collector.result() };
}


/**
 * Clamp the public `grep` arguments into one normalized option set.
 *
 * `max_results` is the deprecated alias of `head_limit`; an explicit
 * `head_limit` wins. `context` only applies to content output.
 */
export function parseGrepOptions(args: Record<string, unknown>): GrepOptions {
  const outputMode = normalizeOutputMode(args.output_mode);
  const limitSource = args.head_limit === undefined || args.head_limit === null ? args.max_results : args.head_limit;
  return {
    query: String(args.query ?? ''),
    regex: args.regex === true,
    caseSensitive: args.case_sensitive === true,
    include: toStringArray(args.include),
    exclude: toStringArray(args.exclude),
    type: normalizeTypeFilter(args.type),
    context: outputMode === 'content' ? clampNumber(args.context, 0, 0, MAX_GREP_CONTEXT) : 0,
    headLimit: clampNumber(limitSource, DEFAULT_GREP_HEAD_LIMIT, 1, MAX_GREP_HEAD_LIMIT),
    offset: clampNumber(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    outputMode,
  };
}


/** Build the ripgrep argv for one normalized grep request. */
export function buildGrepArguments(options: GrepOptions, target: string): string[] {
  const command = ['--json', '--line-number', '--hidden', '--no-messages'];
  if (!options.caseSensitive) command.push('--ignore-case');
  if (!options.regex) command.push('--fixed-strings');
  if (options.outputMode === 'content' && options.context > 0) command.push('--context', String(options.context));
  if (options.type) command.push('--type', options.type);
  command.push(...searchGlobArgs(undefined, options.include, options.exclude), '--', options.query, target);
  return command;
}


/**
 * Incremental ripgrep `--json` event consumer.
 *
 * The parser keeps only the requested page of results: it stops as soon as one
 * extra candidate proves there is more, except in `count` mode where paging is
 * applied after the full (event-capped) scan so per-file statistics stay
 * complete. Keeping this separate from child-process handling makes the event
 * stream testable without a ripgrep binary.
 */
export class GrepEventCollector {
  private readonly options: GrepCollectorOptions;
  private readonly matches: GrepMatchRecord[] = [];
  private readonly files: string[] = [];
  private readonly fileIndex = new Set<string>();
  private readonly counts = new Map<string, number>();
  private readonly countOrder: string[] = [];
  private pendingBefore: GrepContextLine[] = [];
  private currentPath = '';
  private lastMatchIndex = -1;
  private matchCount = 0;
  private eventCount = 0;
  private eventLimitHit = false;
  private stopped = false;

  constructor(options: GrepCollectorOptions) {
    this.options = {
      outputMode: options.outputMode,
      context: clampNumber(options.context, 0, 0, MAX_GREP_CONTEXT),
      headLimit: clampNumber(options.headLimit, DEFAULT_GREP_HEAD_LIMIT, 1, MAX_GREP_HEAD_LIMIT),
      offset: clampNumber(options.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    };
  }

  push(event: RipgrepEvent): void {
    if (this.stopped || !event || typeof event !== 'object') return;
    this.eventCount += 1;
    if (this.eventCount > MAX_GREP_EVENTS) {
      this.eventLimitHit = true;
      this.stopped = true;
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'begin' || type === 'end') {
      this.resetFileState();
      return;
    }
    if (type !== 'match' && type !== 'context') return;
    const data = event.data;
    if (!data) return;
    const rawPath = data.path?.text;
    if (typeof rawPath !== 'string' || !rawPath) return;
    const filePath = normalizeSearchPath(rawPath);
    if (filePath !== this.currentPath) {
      this.currentPath = filePath;
      this.pendingBefore = [];
      this.lastMatchIndex = -1;
    }
    const lineNumber = Math.trunc(Number(data.line_number));
    if (!Number.isFinite(lineNumber)) return;
    const preview = previewFromEventLines(data.lines);

    if (type === 'context') {
      if (this.options.outputMode !== 'content' || this.options.context <= 0) return;
      const contextLine: GrepContextLine = { line: lineNumber, preview };
      const last = this.matches[this.lastMatchIndex];
      if (last && last.context && lineNumber > last.line && last.context.after.length < this.options.context) {
        last.context.after.push(contextLine);
      }
      this.pendingBefore.push(contextLine);
      if (this.pendingBefore.length > this.options.context) this.pendingBefore.shift();
      return;
    }

    this.matchCount += 1;
    this.lastMatchIndex = -1;

    if (this.options.outputMode === 'content') {
      const before = this.options.context > 0 ? this.pendingBefore.slice(-this.options.context) : [];
      this.pendingBefore = [];
      if (this.matchCount <= this.options.offset) return;
      const record: GrepMatchRecord = { path: filePath, line: lineNumber, preview };
      if (this.options.context > 0) record.context = { before: [...before], after: [] };
      this.matches.push(record);
      this.lastMatchIndex = this.matches.length - 1;
      if (this.matches.length > this.options.headLimit) this.stopped = true;
      return;
    }

    if (this.options.outputMode === 'files') {
      if (this.fileIndex.has(filePath)) return;
      this.fileIndex.add(filePath);
      this.files.push(filePath);
      if (this.files.length > this.options.offset + this.options.headLimit) this.stopped = true;
      return;
    }

    const previous = this.counts.get(filePath);
    if (previous === undefined) {
      this.countOrder.push(filePath);
      this.counts.set(filePath, 1);
    } else {
      this.counts.set(filePath, previous + 1);
    }
  }

  /** True when the child process can be stopped: the page plus one extra hit was seen. */
  shouldStop(): boolean {
    return this.stopped;
  }

  /** Mode-specific result fields merged into the tool result by `executeGrep`. */
  result(): Record<string, unknown> {
    const { offset, headLimit } = this.options;
    if (this.options.outputMode === 'content') {
      const returned = this.matches.slice(0, headLimit);
      return {
        output_mode: 'content',
        matches: returned,
        count: returned.length,
        total_matches: this.matchCount,
        truncated: this.matches.length > headLimit || this.eventLimitHit,
        next_offset: offset + returned.length,
      };
    }
    if (this.options.outputMode === 'files') {
      const files = this.files.slice(offset, offset + headLimit);
      return {
        output_mode: 'files',
        files,
        count: files.length,
        total_matches: this.files.length,
        truncated: this.files.length > offset + headLimit || this.eventLimitHit,
        next_offset: offset + files.length,
      };
    }
    const entries = this.countOrder.map((filePath) => ({ path: filePath, count: this.counts.get(filePath) || 0 }));
    const returned = entries.slice(offset, offset + headLimit);
    return {
      output_mode: 'count',
      counts: returned,
      count: returned.length,
      total_matches: this.matchCount,
      truncated: entries.length > offset + headLimit || this.eventLimitHit,
      next_offset: offset + returned.length,
    };
  }

  private resetFileState(): void {
    this.currentPath = '';
    this.pendingBefore = [];
    this.lastMatchIndex = -1;
  }
}


function parseRipgrepEvent(line: string): RipgrepEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as RipgrepEvent;
  } catch {
    return null;
  }
}


function previewFromEventLines(lines: { text?: string } | undefined): string {
  const text = typeof lines?.text === 'string' ? lines.text : '';
  return text.replace(/[\r\n]+$/g, '').slice(0, MAX_PREVIEW_CHARS);
}


function normalizeOutputMode(value: unknown): GrepOutputMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'files' || normalized === 'count' ? normalized : 'content';
}


function normalizeTypeFilter(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  return /^[A-Za-z0-9_+.-]+$/.test(raw) ? raw : undefined;
}


function runRipgrep(args: string[], cwd: string, projectPath: string, onLine: (line: string, stop: () => void) => void, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ripgrepBinary(), args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: toolProcessEnvironment(projectPath) });
    let stderr = '';
    let pending = '';
    let stopped = false;
    let recordTooLarge = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const stop = () => {
      if (!stopped) {
        stopped = true;
        child.kill();
      }
    };
    const abort = () => {
      stop();
      finish(new CoreToolExecutionAbortedError());
    };
    abortSignal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => {
      if (stopped) return;
      pending += String(chunk);
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line.length > MAX_RIPGREP_RECORD_CHARS) {
          recordTooLarge = true;
          stop();
          return;
        }
        if (line) onLine(line, stop);
        newline = pending.indexOf('\n');
      }
      if (pending.length > MAX_RIPGREP_RECORD_CHARS) {
        recordTooLarge = true;
        stop();
      }
    });
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on('error', (err) => finish(new Error(`Unable to run ripgrep: ${err.message}`)));
    child.on('close', (code) => {
      if (recordTooLarge) {
        finish(new Error(`ripgrep output record exceeds ${MAX_RIPGREP_RECORD_CHARS} characters.`));
        return;
      }
      if (pending && !stopped) onLine(pending.replace(/\r$/, ''), stop);
      if (!stopped && code !== 0 && code !== 1) finish(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
      else finish();
    });
  });
}


/** Test/integration seam: honour `RG_PATH` so grep tests can point at a specific ripgrep build. */
function ripgrepBinary(): string {
  const explicit = process.env.RG_PATH?.trim();
  return explicit || 'rg';
}


function searchGlobArgs(pattern: string | undefined, include: string[] | undefined, exclude: string[] | undefined): string[] {
  const patterns = [
    ...DEFAULT_SEARCH_EXCLUDES,
    ...(exclude || []).map((value) => value.startsWith('!') ? value : `!${value}`),
    ...(include || []),
    ...(pattern ? [pattern] : []),
  ];
  return patterns.flatMap((value) => ['--glob', value]);
}


function normalizeSearchPath(value: string): string {
  return normalizePath(value.replace(/^\.\//, ''));
}


function resolveSearchLocation(root: string): { cwd: string; target: string } {
  const stat = fs.statSync(root);
  return stat.isDirectory()
    ? { cwd: root, target: '.' }
    : { cwd: path.dirname(root), target: path.basename(root) };
}

function toStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : undefined;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}
