import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG_ROOT } from '../../paths.js';

const PROMPT_INDEX_FILE = 'prompts.json';

export interface SystemPrompt {
  id: string;
  name: string;
  description: string;
  content: string;
  tags: string[];
  variables: string[];
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface PromptIndexEntry extends Omit<SystemPrompt, 'content'> {
  file: string;
}

/**
 * Prompt definitions are configuration, not runtime state.  The JSON index
 * keeps metadata while each prompt body remains a reviewable Markdown file.
 */
export function getAllSystemPrompts(): SystemPrompt[] {
  return readIndex().map(toPrompt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getSystemPrompt(id: string): SystemPrompt | undefined {
  const entry = readIndex().find((item) => item.id === id);
  return entry ? toPrompt(entry) : undefined;
}

export function createSystemPrompt(data: Omit<SystemPrompt, 'id' | 'version' | 'createdAt' | 'updatedAt'>): SystemPrompt {
  const now = new Date().toISOString();
  const id = uuidv4();
  const entries = readIndex();
  if (data.isDefault !== false) entries.forEach((entry) => { entry.isDefault = false; });
  const entry: PromptIndexEntry = {
    id,
    name: data.name || '系统提示词',
    description: data.description || '',
    file: `prompts/${id}.md`,
    tags: data.tags || [],
    variables: data.variables || [],
    isDefault: data.isDefault !== false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  writePromptBody(entry.file, data.content);
  entries.push(entry);
  writeIndex(entries);
  return toPrompt(entry);
}

export function updateSystemPrompt(id: string, data: Partial<SystemPrompt>): SystemPrompt | undefined {
  const entries = readIndex();
  const entry = entries.find((item) => item.id === id);
  if (!entry) return undefined;
  if (data.isDefault) entries.forEach((item) => { item.isDefault = false; });
  if (data.name !== undefined) entry.name = data.name;
  if (data.description !== undefined) entry.description = data.description;
  if (data.tags !== undefined) entry.tags = data.tags;
  if (data.variables !== undefined) entry.variables = data.variables;
  if (data.isDefault !== undefined) entry.isDefault = data.isDefault;
  if (data.content !== undefined) {
    writePromptBody(entry.file, data.content);
    entry.version += 1;
  }
  entry.updatedAt = new Date().toISOString();
  writeIndex(entries);
  return toPrompt(entry);
}

export function getDefaultSystemPrompt(): SystemPrompt | undefined {
  return getAllSystemPrompts().find((prompt) => prompt.isDefault) || getAllSystemPrompts()[0];
}

export function deleteSystemPrompt(id: string): boolean {
  const entries = readIndex();
  const entry = entries.find((item) => item.id === id);
  if (!entry) return false;
  writeIndex(entries.filter((item) => item.id !== id));
  const filePath = resolveConfigPath(entry.file);
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  return true;
}

function readIndex(): PromptIndexEntry[] {
  const indexPath = resolveConfigPath(PROMPT_INDEX_FILE);
  if (!fs.existsSync(indexPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, '')) as unknown;
  const items = Array.isArray(parsed) ? parsed : (parsed as { prompts?: unknown[] }).prompts;
  return Array.isArray(items) ? items.filter(isPromptIndexEntry) : [];
}

function writeIndex(entries: PromptIndexEntry[]): void {
  writeAtomically(resolveConfigPath(PROMPT_INDEX_FILE), `${JSON.stringify({ prompts: entries }, null, 2)}\n`);
}

function toPrompt(entry: PromptIndexEntry): SystemPrompt {
  return { ...entry, content: readPromptBody(entry.file), tags: [...entry.tags], variables: [...entry.variables] };
}

function isPromptIndexEntry(value: unknown): value is PromptIndexEntry {
  return Boolean(value && typeof value === 'object' && typeof (value as PromptIndexEntry).id === 'string' && typeof (value as PromptIndexEntry).file === 'string');
}

function readPromptBody(relativePath: string): string {
  const filePath = resolveConfigPath(relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function writePromptBody(relativePath: string, content: string): void {
  writeAtomically(resolveConfigPath(relativePath), content);
}

function resolveConfigPath(relativePath: string): string {
  const configDir = path.resolve(process.env.BIOFLOW_CONFIG_DIR || CONFIG_ROOT);
  const target = path.resolve(configDir, relativePath);
  if (!target.startsWith(`${configDir}${path.sep}`)) throw new Error(`Prompt path escapes configuration directory: ${relativePath}`);
  return target;
}

function writeAtomically(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}
