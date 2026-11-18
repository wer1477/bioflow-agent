import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT } from '../../paths.js';

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getEnvironmentFilePath(): string {
  return path.resolve(process.env.BIOFLOW_ENV_FILE || path.join(BACKEND_ROOT, '.env'));
}

export function llmApiKeyEnvironmentName(providerId: string): string {
  return `BIOFLOW_LLM_API_KEY_${providerId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
}

export function mcpCredentialEnvironmentName(serverId: string, fieldName: string): string {
  const server = serverId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase() || 'SERVER';
  const field = fieldName.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase() || 'CREDENTIAL';
  return `BIOFLOW_MCP_${server}_${field}`;
}

export function environmentReference(name: string): string {
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) throw new Error('Invalid environment variable name.');
  return '${' + name + '}';
}

/** Persist a local secret outside JSON configuration and make it available now. */
export function persistEnvironmentSecret(name: string, value: string): void {
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) throw new Error('Invalid environment variable name.');
  if (!value || /[\r\n]/.test(value)) throw new Error('API Key must not be empty or contain a line break.');

  const target = getEnvironmentFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const assignment = `${name}=${JSON.stringify(value)}`;
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const assignmentPattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=.*$`, 'm');
  const next = assignmentPattern.test(existing)
    ? existing.replace(assignmentPattern, assignment)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${assignment}\n`;
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, next, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  process.env[name] = value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
