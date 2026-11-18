import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { loadBackendConfig } from '../../agent/config/backend_config_loader.js';
import { assertSecretReferences } from '../../agent/config/secret_config.js';
import { AGENT_CLIENT_ROOT, CONFIG_ROOT, SKILLS_ROOT } from '../../paths.js';

const router = express.Router();
const ROOTS = {
  config: () => path.resolve(process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT),
  skills: () => SKILLS_ROOT,
} as const;

type RootName = keyof typeof ROOTS;

router.get('/', (_req, res) => {
  res.json({
    roots: Object.fromEntries(Object.entries(ROOTS).map(([name, getRoot]) => [name, path.relative(AGENT_CLIENT_ROOT, getRoot()).replace(/\\/g, '/')])),
    files: listManagedFiles(),
  });
});

router.get('/:root/*filePath', (req, res) => {
  const resolved = resolveManagedPath(req.params.root, req.params.filePath);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isFile()) {
    res.status(404).json({ error: 'Config file not found' });
    return;
  }
  if (isSecretConfigFile(req.params.root, req.params.filePath)) {
    res.status(403).json({ error: 'Secret-bearing config files cannot be read through this API. Use environment variable references to configure credentials.' });
    return;
  }
  res.json({
    root: req.params.root,
    path: normalizeRelativePath(req.params.filePath),
    content: fs.readFileSync(resolved.path, 'utf8'),
  });
});

router.put('/:root/*filePath', (req, res) => {
  const resolved = resolveManagedPath(req.params.root, req.params.filePath);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }

  const content = String(req.body?.content ?? '');
  const ext = path.extname(resolved.path).toLowerCase();
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content || '{}');
      if (isSecretConfigFile(req.params.root, req.params.filePath)) assertSecretReferences(parsed);
    } catch (err) {
      res.status(400).json({ error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
  }

  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  writeAtomically(resolved.path, content);
  const reload = loadBackendConfig();
  res.json({
    ok: true,
    file: {
      root: req.params.root,
      path: normalizeRelativePath(req.params.filePath),
    },
    reload,
  });
});

function listManagedFiles() {
  return (Object.keys(ROOTS) as RootName[]).flatMap((root) => {
    const rootPath = ROOTS[root]();
    if (!fs.existsSync(rootPath)) return [];
    return walkTextFiles(rootPath).map((filePath) => ({
      root,
      path: path.relative(rootPath, filePath).replace(/\\/g, '/'),
      size: fs.statSync(filePath).size,
      updatedAt: fs.statSync(filePath).mtime.toISOString(),
    }));
  });
}

function walkTextFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTextFiles(entryPath));
    } else if (entry.isFile() && isEditableFile(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function isEditableFile(fileName: string): boolean {
  return /\.(json|md|txt|js|mjs|ts|yaml|yml)$/i.test(fileName);
}

function resolveManagedPath(rootName: string, relativePath: string | string[]) {
  if (!isRootName(rootName)) {
    return { ok: false as const, status: 404, error: 'Unknown config root' };
  }
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.split('/').some((part) => part === '..')) {
    return { ok: false as const, status: 400, error: 'Invalid config file path' };
  }
  if (!isEditableFile(normalized)) {
    return { ok: false as const, status: 400, error: 'File type is not editable through this API' };
  }

  const root = ROOTS[rootName]();
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return { ok: false as const, status: 400, error: 'Config file path escapes its root' };
  }
  return { ok: true as const, path: resolved };
}

function normalizeRelativePath(value: string | string[]): string {
  const raw = Array.isArray(value) ? value.join('/') : value;
  return String(raw || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function isRootName(value: string): value is RootName {
  return value === 'config' || value === 'skills';
}

function isSecretConfigFile(root: string, filePath: string | string[]): boolean {
  if (root !== 'config') return false;
  const fileName = normalizeRelativePath(filePath);
  return fileName === 'llm.json' || fileName === 'mcp.json';
}

function writeAtomically(filePath: string, content: string): void {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export default router;
