import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseDocument, stringify } from 'yaml';
import { readConfig, writeConfig } from './file_config.js';
import { remapSkillReferences } from './agent_config_store.js';
import { CONFIG_ROOT, SKILLS_ROOT } from '../../paths.js';

/**
 * Skill discovery is flat: every skill is a direct child of `agent-client/skills/`
 * that contains a `SKILL.md`, and its id is the slug of the frontmatter name. The
 * directory tree that used to group skills has been retired; the curated Tool
 * Library (`agent-client/toollibrary/`) is the only classification surface.
 */

const DELETED_SKILLS_FILE = '.deleted-skills.json';
const SKILL_INDEX_FILE = 'skills.json';
const SKILL_FILE = 'SKILL.md';
const RESOURCES_DIRECTORY = 'resources';

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  resources: SkillResource[];
  enabled: boolean;
  promptId: string | null;
  examples: string;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * Absolute source directory this Skill was read from. Runtime-only: it is not
   * persisted in the skills index and lets provenance metadata resolve without a
   * second filesystem lookup or a duplicated path table.
   */
  directory?: string;
}

export interface SkillResource {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface SkillDirectoryImportFile { path: string; content: string; encoding: 'utf8' | 'base64'; }
export interface SkillDiagnostic { path: string; message: string; }

interface StoredSkill {
  id: string;
  enabled: boolean;
  promptId: string | null;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}
interface SkillIndex { skills: StoredSkill[]; }
interface SkillSnapshot { skills: Skill[]; diagnostics: SkillDiagnostic[]; }

let skillDiagnostics: SkillDiagnostic[] = [];
let skillSnapshot: SkillSnapshot | null = null;
let skillWatchers = new Map<string, fs.FSWatcher>();
let skillRefreshTimer: NodeJS.Timeout | null = null;

export function getAllSkills(): Skill[] { return [...getSkillSnapshot().skills]; }
export function getSkill(id: string): Skill | undefined { return getSkillSnapshot().skills.find((skill) => skill.id === id); }
export function getSkillDiagnostics(): SkillDiagnostic[] { return [...skillDiagnostics]; }
export function reloadSkillCache(): void { refreshSkillSnapshot(); }

export function createSkill(data: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>): Skill {
  const now = new Date().toISOString();
  const { name, description } = validateSkillMetadata(data.name, data.description);
  const skill: Skill = {
    id: skillDirectoryName({ name }), name, description, instructions: data.instructions || data.examples || '',
    resources: normalizeSkillResources(data.resources), enabled: data.enabled !== false,
    promptId: data.promptId || null, examples: data.examples || data.instructions || '',
    isBuiltin: Boolean(data.isBuiltin), createdAt: now, updatedAt: now,
  };
  forgetDeletedSkill(skill.id);
  writeSkillDirectory(skill);
  const index = loadIndex();
  index.skills.push(toStoredSkill(skill));
  saveIndex(index);
  invalidateSkillCache();
  return skill;
}

export function updateSkill(id: string, data: Partial<Skill>): Skill | undefined {
  const existing = getSkill(id);
  if (!existing) return undefined;
  const { name, description } = validateSkillMetadata(data.name === undefined ? existing.name : data.name, data.description === undefined ? existing.description : data.description);
  const next: Skill = {
    ...existing,
    ...data,
    id: skillDirectoryName({ name }),
    name,
    description,
    resources: data.resources === undefined ? existing.resources : normalizeSkillResources(data.resources),
    updatedAt: new Date().toISOString(),
  };
  writeSkillDirectory(next, findSkillDirectory(existing.id));
  const index = loadIndex();
  index.skills = index.skills.filter((skill) => skill.id !== existing.id && skill.id !== next.id);
  index.skills.push(toStoredSkill(next));
  saveIndex(index);
  if (existing.id !== next.id) migrateAgentSkillReferences(new Map([[existing.id, next.id]]));
  invalidateSkillCache();
  return next;
}

export function deleteSkill(id: string): boolean {
  const existing = getSkill(id);
  if (!existing) return false;
  const skillDir = findSkillDirectory(id);
  if (skillDir) {
    rememberDeletedSkill(id);
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
  const index = loadIndex();
  index.skills = index.skills.filter((skill) => skill.id !== id);
  saveIndex(index);
  invalidateSkillCache();
  return true;
}

export function getEnabledSkills(): Skill[] { return getSkillSnapshot().skills.filter((skill) => skill.enabled); }

function getSkillSnapshot(): SkillSnapshot {
  if (!skillSnapshot) refreshSkillSnapshot();
  if (!skillSnapshot) throw new Error('Skill index could not be initialized.');
  return skillSnapshot;
}

function invalidateSkillCache(): void {
  skillSnapshot = null;
}

function scheduleSkillRefresh(): void {
  if (skillRefreshTimer) clearTimeout(skillRefreshTimer);
  skillRefreshTimer = setTimeout(() => {
    skillRefreshTimer = null;
    refreshSkillSnapshot();
  }, 150);
  skillRefreshTimer.unref();
}

function refreshSkillSnapshot(): void {
  const previousDiagnostics = skillDiagnostics;
  try {
    skillSnapshot = rebuildSkillSnapshot();
  } catch (error) {
    skillDiagnostics = previousDiagnostics;
    console.warn(`[skills] Keeping the previous skill snapshot after refresh failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rebuildSkillSnapshot(): SkillSnapshot {
  skillDiagnostics = [];
  const index = loadIndex();
  const deleted = readDeletedSkillMarkers();
  const root = ensureSkillsRoot();
  const skills: Skill[] = [];
  const migratedIds = new Map<string, string>();
  let changed = false;
  for (const skillDir of listSkillDirectories(root)) {
    const folder = path.basename(skillDir);
    const legacyPrefix = folder.match(/^([0-9a-f]{8})-/i)?.[1]?.toLowerCase();
    const legacyId = legacyPrefix ? knownIdForPrefix(legacyPrefix) : undefined;
    const existing = index.skills.find((skill) => skill.id === folder)
      || index.skills.find((skill) => legacyPrefix && skill.id.toLowerCase().startsWith(legacyPrefix))
      || (legacyId ? index.skills.find((skill) => skill.id === legacyId) : undefined);
    if (isDeletedSkill(folder, existing?.id || legacyId, deleted)) continue;
    let parsed: Pick<Skill, 'name' | 'description' | 'instructions'>;
    try {
      parsed = parseSkillMarkdown(fs.readFileSync(path.join(skillDir, SKILL_FILE), 'utf8'), skillNameFromDirectory(folder));
    } catch (error) {
      recordSkillDiagnostic(skillDir, error);
      continue;
    }
    const targetName = skillDirectoryName(parsed);
    const target = path.join(root, targetName);
    if (path.resolve(skillDir) !== path.resolve(target)) {
      if (fs.existsSync(target)) throw new Error(`Skill target directory already exists: ${target}`);
      fs.renameSync(skillDir, target);
    }
    const id = targetName;
    if (existing?.id && existing.id !== id) migratedIds.set(existing.id, id);
    if (legacyId && legacyId !== id) migratedIds.set(legacyId, id);
    const skill = readSkillDirectory(target, { ...existing, id }, parsed);
    skills.push(skill);
    if (JSON.stringify(existing) !== JSON.stringify(toStoredSkill(skill))) changed = true;
  }
  for (const skillDir of listNestedSkillDirectories(root)) {
    recordSkillDiagnostic(skillDir, new Error('skill directories must be direct children of skills/; move this skill to the skills root.'));
  }
  const nextStored = skills.map(toStoredSkill);
  if (hasSkillIndex() && (changed || nextStored.length !== index.skills.length)) {
    index.skills = nextStored;
    saveIndex(index);
  }
  migrateAgentSkillReferences(migratedIds);
  updateSkillWatchers();
  return {
    skills: skills.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    diagnostics: [...skillDiagnostics],
  };
}

function loadIndex(): SkillIndex {
  const raw = readConfig(SKILL_INDEX_FILE);
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<SkillIndex> : {};
  return {
    skills: Array.isArray(object.skills) ? object.skills.filter(isStoredSkill).map((skill) => ({
      id: skill.id,
      enabled: skill.enabled,
      promptId: skill.promptId,
      isBuiltin: skill.isBuiltin,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    })) : [],
  };
}

function hasSkillIndex(): boolean {
  const configDir = path.resolve(process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT);
  return fs.existsSync(path.join(configDir, SKILL_INDEX_FILE));
}

function saveIndex(index: SkillIndex): void { writeConfig(SKILL_INDEX_FILE, { skills: index.skills }); }
function toStoredSkill(skill: Skill): StoredSkill {
  return {
    id: skill.id,
    enabled: skill.enabled,
    promptId: skill.promptId,
    isBuiltin: skill.isBuiltin,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}
function isStoredSkill(value: unknown): value is StoredSkill { return Boolean(value && typeof value === 'object' && typeof (value as StoredSkill).id === 'string'); }

function knownIdForPrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  const raw = readConfig('agents.json');
  const agents = Array.isArray(raw) ? raw : Array.isArray(raw?.agents) ? raw.agents : [];
  for (const agent of agents) {
    const id = Array.isArray(agent?.skillIds) ? agent.skillIds.find((item: unknown) => String(item).toLowerCase().startsWith(prefix)) : undefined;
    if (id) return String(id);
  }
  return undefined;
}

function migrateAgentSkillReferences(migratedIds: Map<string, string>): void {
  if (migratedIds.size) remapSkillReferences(migratedIds);
}

function recordSkillDiagnostic(skillPath: string, error: unknown, displayPath?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const pathValue = displayPath || path.relative(ensureSkillsRoot(), skillPath).replace(/\\/g, '/');
  skillDiagnostics.push({ path: pathValue || path.basename(skillPath), message });
  console.warn(`[skills] Ignoring ${pathValue || skillPath}: ${message}`);
}

export function readSkillDirectory(skillDir: string, existing: Partial<StoredSkill>, parsed = parseSkillMarkdown(fs.readFileSync(path.join(skillDir, SKILL_FILE), 'utf8'), skillNameFromDirectory(path.basename(skillDir)))): Skill {
  const now = new Date().toISOString();
  return {
    id: existing.id || path.basename(skillDir), name: parsed.name, description: parsed.description, instructions: parsed.instructions,
    resources: readSkillResourceDirectory(skillDir), enabled: existing.enabled !== false,
    promptId: existing.promptId || null, examples: parsed.instructions,
    isBuiltin: Boolean(existing.isBuiltin), createdAt: existing.createdAt || now, updatedAt: now,
    directory: path.resolve(skillDir),
  };
}

function writeSkillDirectory(skill: Skill, currentDir = findSkillDirectory(skill.id)): void {
  const root = ensureSkillsRoot();
  const desiredDir = path.join(root, skillDirectoryName(skill));
  let target = currentDir || desiredDir;
  if (currentDir && path.resolve(currentDir) !== path.resolve(desiredDir)) {
    if (fs.existsSync(desiredDir)) throw new Error(`Skill target directory already exists: ${desiredDir}`);
    fs.renameSync(currentDir, desiredDir);
    target = desiredDir;
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, SKILL_FILE), buildSkillMarkdown(skill), 'utf8');
  writeSkillResourceDirectory(target, skill.resources);
}

function normalizeSkillResources(resources: SkillResource[] | undefined): SkillResource[] {
  return (resources || []).map((resource): SkillResource => ({ id: resource.id || uuidv4(), fileName: resource.fileName, mimeType: resource.mimeType || 'application/octet-stream', size: Number(resource.size || 0), content: resource.content || '', encoding: resource.encoding === 'base64' ? 'base64' : 'utf8' })).filter((resource) => resource.fileName);
}

function writeSkillResourceDirectory(skillDir: string, resources: SkillResource[]): void {
  const resourcesDir = path.join(skillDir, RESOURCES_DIRECTORY);
  fs.rmSync(resourcesDir, { recursive: true, force: true });
  if (!resources.length) return;
  fs.mkdirSync(resourcesDir, { recursive: true });
  for (const resource of resources) {
    const name = safeRelativeResourcePath(resource.fileName); if (!name) continue;
    const target = path.join(resourcesDir, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, resource.encoding === 'base64' ? Buffer.from(resource.content || '', 'base64') : resource.content || '', resource.encoding === 'base64' ? undefined : 'utf8');
  }
}

function readSkillResourceDirectory(skillDir: string): SkillResource[] {
  const resourcesDir = path.join(skillDir, RESOURCES_DIRECTORY); if (!fs.existsSync(resourcesDir)) return [];
  return walkFiles(resourcesDir).map((filePath) => {
    const buffer = fs.readFileSync(filePath); const text = isTextResource(filePath, buffer);
    return { id: uuidv4(), fileName: path.relative(resourcesDir, filePath).replace(/\\/g, '/'), mimeType: guessMimeType(filePath, text), size: buffer.byteLength, content: text ? buffer.toString('utf8') : buffer.toString('base64'), encoding: text ? 'utf8' : 'base64' };
  });
}

function findSkillDirectory(skillId: string): string | null {
  const root = ensureSkillsRoot();
  const target = path.resolve(root, skillId);
  if (path.dirname(target) !== root) return null;
  return fs.existsSync(path.join(target, SKILL_FILE)) ? target : null;
}

/** Skills are scanned one level deep: only direct children of the skills root. */
function listSkillDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules')
    .map((entry) => path.join(root, entry.name))
    .filter((target) => fs.existsSync(path.join(target, SKILL_FILE)));
}

/** Directories that would be skills under the old recursive scan (diagnostic only). */
function listNestedSkillDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const nested: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
    const target = path.join(root, entry.name);
    if (fs.existsSync(path.join(target, SKILL_FILE))) continue;
    if (containsSkillFile(target, 3)) nested.push(target);
  }
  return nested;
}

function containsSkillFile(directory: string, depth: number): boolean {
  if (depth < 0) return false;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (entry.name === RESOURCES_DIRECTORY || entry.name === '.git' || entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === SKILL_FILE) return true;
    if (entry.isDirectory() && containsSkillFile(target, depth - 1)) return true;
  }
  return false;
}

function updateSkillWatchers(): void {
  const root = ensureSkillsRoot();
  const directories = new Set(listDirectories(root));
  for (const [directory, watcher] of skillWatchers) {
    if (directories.has(directory)) continue;
    watcher.close();
    skillWatchers.delete(directory);
  }
  for (const directory of directories) {
    if (skillWatchers.has(directory)) continue;
    try {
      const watcher = fs.watch(directory, { persistent: false }, () => scheduleSkillRefresh());
      watcher.on('error', (error) => {
        skillWatchers.delete(directory);
        console.warn(`[skills] Watcher failed for ${directory}: ${error.message}`);
        scheduleSkillRefresh();
      });
      watcher.unref();
      skillWatchers.set(directory, watcher);
    } catch (error) {
      console.warn(`[skills] Unable to watch ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function listDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const directories = [root];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
    directories.push(...listDirectories(path.join(root, entry.name)));
  }
  return directories;
}

function ensureSkillsRoot(): string { const root = SKILLS_ROOT; fs.mkdirSync(root, { recursive: true }); return root; }
function skillDirectoryName(skill: Pick<Skill, 'name'>): string { return slugifyPathSegment(skill.name || 'skill'); }
function skillNameFromDirectory(folder: string): string { return folder.replace(/^[0-9a-f]{8}-/i, '') || 'skill'; }
function slugifyPathSegment(value: string): string { return value.trim().toLowerCase().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill'; }
function safeRelativeResourcePath(value: string): string { const normalized = value.replace(/\\/g, '/').split('/').filter(Boolean).join('/'); return !normalized || normalized.split('/').some((part) => part === '..') ? '' : normalized.replace(/[<>:"\\|?*\x00-\x1F]/g, '-'); }
function walkFiles(dir: string): string[] { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { const target = path.join(dir, entry.name); return entry.isDirectory() ? walkFiles(target) : entry.isFile() ? [target] : []; }); }
function isTextResource(filePath: string, buffer: Buffer): boolean { return /\.(md|txt|json|js|mjs|ts|tsx|jsx|py|sh|ps1|yaml|yml|toml|xml|html|css|csv|tsv)$/i.test(filePath) || !buffer.includes(0); }
function guessMimeType(filePath: string, text: boolean): string { const ext = path.extname(filePath).toLowerCase(); const types: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values' }; return types[ext] || (text ? 'text/plain' : 'application/octet-stream'); }

interface DeletedSkillMarkers { ids: string[]; }
function readDeletedSkillMarkers(): DeletedSkillMarkers {
  const target = path.join(ensureSkillsRoot(), DELETED_SKILLS_FILE);
  if (!fs.existsSync(target)) return { ids: [] };
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<DeletedSkillMarkers>;
    return { ids: Array.isArray(value.ids) ? value.ids.map(String) : [] };
  } catch {
    return { ids: [] };
  }
}
function rememberDeletedSkill(id: string): void {
  const markers = readDeletedSkillMarkers();
  markers.ids.push(id);
  fs.writeFileSync(path.join(ensureSkillsRoot(), DELETED_SKILLS_FILE), JSON.stringify({ ids: [...new Set(markers.ids)] }, null, 2), 'utf8');
}
function forgetDeletedSkill(id: string): void {
  const target = path.join(ensureSkillsRoot(), DELETED_SKILLS_FILE);
  if (!fs.existsSync(target)) return;
  const markers = readDeletedSkillMarkers();
  fs.writeFileSync(target, JSON.stringify({ ids: markers.ids.filter((item) => item !== id) }, null, 2), 'utf8');
}
function isDeletedSkill(folder: string, id: string | undefined, markers: DeletedSkillMarkers): boolean {
  if (markers.ids.includes(folder) || Boolean(id && markers.ids.includes(id))) return true;
  const legacyPrefix = folder.match(/^([0-9a-f]{8})-/i)?.[1]?.toLowerCase();
  return Boolean(legacyPrefix && markers.ids.some((marker) => marker.toLowerCase().startsWith(legacyPrefix)));
}

export function buildSkillMarkdown(skill: Pick<Skill, 'name' | 'description' | 'instructions'>): string {
  const metadata = validateSkillMetadata(skill.name, skill.description);
  return ['---', stringify(metadata, { lineWidth: 0 }).trimEnd(), '---', '', skill.instructions || ''].join('\n');
}

export function parseSkillMarkdown(markdown: string, fallbackName = ''): Pick<Skill, 'name' | 'description' | 'instructions'> {
  const text = markdown.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (!/^---[\t ]*$/.test(lines[0] || '')) throw new Error('SKILL.md must begin with a YAML frontmatter delimiter (---).');
  const closingIndex = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)[\t ]*$/.test(line));
  if (closingIndex < 0) throw new Error('SKILL.md frontmatter is missing its closing delimiter.');
  const document = parseDocument(lines.slice(1, closingIndex).join('\n'), { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid YAML frontmatter: ${document.errors[0].message}`);
  const values = document.toJS();
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('SKILL.md frontmatter must be a YAML mapping.');
  const metadata = values as Record<string, unknown>;
  const name = metadata.name === undefined ? fallbackName : metadata.name;
  return {
    ...validateSkillMetadata(name, metadata.description),
    instructions: lines.slice(closingIndex + 1).join('\n').trim(),
  };
}

function validateSkillMetadata(name: unknown, description: unknown): Pick<Skill, 'name' | 'description'> {
  if (typeof name !== 'string' || !name.trim()) throw new Error('SKILL.md frontmatter requires a name, or the skill directory must provide one.');
  const normalizedName = name.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedName) || normalizedName.length > 64) {
    throw new Error('SKILL.md name must be 1-64 lowercase letters, digits, or single hyphens.');
  }
  if (typeof description !== 'string' || !description.trim()) throw new Error('SKILL.md frontmatter requires a non-empty description.');
  return { name: normalizedName, description: description.trim() };
}

export async function importSkillsFromZip(fileName: string, base64Content: string): Promise<Skill[]> {
  if (!/\.zip$/i.test(fileName)) throw new Error('Only .zip skill packages are supported'); if (!base64Content.trim()) throw new Error('zip content is required');
  skillDiagnostics = [];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-skill-zip-')); const archive = path.join(temporary, path.basename(fileName)); const extracted = path.join(temporary, 'extracted');
  try { fs.writeFileSync(archive, Buffer.from(base64Content, 'base64')); fs.mkdirSync(extracted, { recursive: true }); await extractZipArchive(archive, extracted); return importSkillsFromDirectoryTree(extracted); } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function importSkillsFromDirectoryFiles(files: SkillDirectoryImportFile[]): Skill[] {
  if (!files.length) throw new Error('No files were provided for directory import'); const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-skill-dir-'));
  skillDiagnostics = [];
  try { for (const file of files) { const relative = safeRelativeResourcePath(file.path); if (!relative) throw new Error(`Invalid import path: ${file.path}`); const target = path.join(temporary, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.encoding === 'base64' ? Buffer.from(file.content || '', 'base64') : file.content || '', file.encoding === 'base64' ? undefined : 'utf8'); } return importSkillsFromDirectoryTree(temporary); } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function extractZipArchive(archivePath: string, outputDir: string): Promise<void> { const command = process.platform === 'win32' ? 'powershell.exe' : 'unzip'; const args = process.platform === 'win32' ? ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', archivePath, '-DestinationPath', outputDir, '-Force'] : ['-o', archivePath, '-d', outputDir]; const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr?.on('data', (chunk) => { stderr += String(chunk); }); const [code] = await once(child, 'close') as [number | null]; if (code !== 0) throw new Error(`Failed to extract zip package: ${stderr || `exit code ${code}`}`); }
function importSkillsFromDirectoryTree(root: string): Skill[] {
  const files = walkFiles(root).filter((file) => path.basename(file).toLowerCase() === 'skill.md');
  if (!files.length) throw new Error('No SKILL.md file found in the imported package');
  const skills: Skill[] = [];
  for (const file of files) {
    const skillDir = path.dirname(file);
    const displayPath = path.relative(root, file).replace(/\\/g, '/');
    try {
      const parsed = parseSkillMarkdown(fs.readFileSync(file, 'utf8'), skillNameFromDirectory(path.basename(skillDir)));
      skills.push(createSkill({ ...parsed, resources: readImportedResources(skillDir), enabled: true, promptId: null, examples: parsed.instructions, isBuiltin: false }));
    } catch (error) {
      recordSkillDiagnostic(file, error, displayPath);
    }
  }
  if (!skills.length) throw new Error(`No valid skills were imported. ${skillDiagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join(' ')}`);
  return skills;
}
function readImportedResources(skillDir: string): SkillResource[] { const resourcesDir = path.join(skillDir, RESOURCES_DIRECTORY); if (fs.existsSync(resourcesDir)) return readSkillResourceDirectory(skillDir); return walkFiles(skillDir).filter((file) => path.basename(file).toLowerCase() !== 'skill.md').map((file) => { const buffer = fs.readFileSync(file); const text = isTextResource(file, buffer); return { id: uuidv4(), fileName: path.relative(skillDir, file).replace(/\\/g, '/'), mimeType: guessMimeType(file, text), size: buffer.byteLength, content: text ? buffer.toString('utf8') : buffer.toString('base64'), encoding: text ? 'utf8' : 'base64' }; }); }
