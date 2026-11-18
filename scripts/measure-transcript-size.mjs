#!/usr/bin/env node
/**
 * Measure what the transcript logs actually cost on disk.
 *
 * Read-only. This exists so the question "do we need to compress the transcript?"
 * is answered with numbers from real sessions instead of a guess: the log stores a
 * full model-visible request per turn, and raw provider stream chunks per token, so
 * the interesting figure is not the file size but *which record type* dominates it.
 *
 * Usage:
 *   node scripts/measure-transcript-size.mjs [--root <dir>] [--json] [--top <n>]
 *
 * Default root is the same session store the backend uses:
 *   $BIOFLOW_WORKSPACE_DIR/.sessions  (falling back to agent-client/workspace/.sessions)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { root: '', json: false, top: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--root') options.root = argv[++index] ?? '';
    else if (arg === '--top') options.top = Number(argv[++index]) || 5;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/measure-transcript-size.mjs [--root <dir>] [--json] [--top <n>]\n');
      process.exit(0);
    }
  }
  return options;
}

function resolveSessionsRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  const configured = process.env.BIOFLOW_WORKSPACE_DIR;
  const workspaceRoot = configured
    ? (path.isAbsolute(configured) ? configured : path.join(REPO_ROOT, configured))
    : path.join(REPO_ROOT, 'agent-client', 'workspace');
  return path.join(workspaceRoot, '.sessions');
}

function findLogs(root) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'events.jsonl') found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

function measure(file) {
  const text = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');
  const byType = new Map();
  let lines = 0;
  let largest = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    let type = '<unparseable>';
    try {
      type = JSON.parse(line).type ?? '<no type>';
    } catch {
      /* counted as unparseable; the reader would refuse this file anyway */
    }
    const bucket = byType.get(type) ?? { type, count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += lineBytes;
    byType.set(type, bucket);
    if (!largest || lineBytes > largest.bytes) largest = { type, bytes: lineBytes };
  }

  return {
    file,
    lines,
    bytes,
    largest,
    byType: [...byType.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolveSessionsRoot(options.root);
  const files = findLogs(root);

  if (files.length === 0) {
    process.stdout.write(`no transcript logs under ${root}\n`);
    return;
  }

  const reports = files.map(measure);
  const totalBytes = reports.reduce((sum, report) => sum + report.bytes, 0);
  const totalLines = reports.reduce((sum, report) => sum + report.lines, 0);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ root, totalBytes, totalLines, files: reports }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`root: ${root}\n`);
  process.stdout.write(`${files.length} log(s), ${totalLines} records, ${formatBytes(totalBytes)}\n\n`);

  const aggregate = new Map();
  for (const report of reports) {
    for (const bucket of report.byType) {
      const entry = aggregate.get(bucket.type) ?? { type: bucket.type, count: 0, bytes: 0 };
      entry.count += bucket.count;
      entry.bytes += bucket.bytes;
      aggregate.set(bucket.type, entry);
    }
  }

  process.stdout.write('by record type (share of total bytes):\n');
  for (const entry of [...aggregate.values()].sort((a, b) => b.bytes - a.bytes)) {
    const share = ((entry.bytes / totalBytes) * 100).toFixed(1);
    process.stdout.write(
      `  ${entry.type.padEnd(16)} ${String(entry.count).padStart(6)} records  ${formatBytes(entry.bytes).padStart(10)}  ${share.padStart(5)}%\n`,
    );
  }

  process.stdout.write(`\nlargest single records:\n`);
  for (const report of [...reports].sort((a, b) => (b.largest?.bytes ?? 0) - (a.largest?.bytes ?? 0)).slice(0, options.top)) {
    if (!report.largest) continue;
    process.stdout.write(`  ${formatBytes(report.largest.bytes).padStart(10)}  ${report.largest.type}  (${path.relative(root, report.file)})\n`);
  }
}

main();
