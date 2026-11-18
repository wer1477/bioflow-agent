#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(cliDir, '..');
const backendDir = path.join(projectRoot, 'backend');
const backendEntry = path.join(backendDir, 'dist', 'index.js');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const argv = process.argv.slice(2);
const [command = '', ...restArgs] = argv;

if (command === '--help' || command === '-h' || command === 'help') {
  printHelp();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log('bioflow 0.1.0');
  process.exit(0);
}

try {
  if (command === 'mcp') {
    await manageMcp(restArgs);
  } else if (!command || command.startsWith('-') || command === 'start') {
    await ensureBackendBuilt();
    startBackend(command === 'start' ? restArgs : argv);
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
} catch (error) {
  console.error(`bioflow: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function ensureBackendBuilt() {
  if (existsSync(backendEntry) && !isSourceNewerThanBackendBuild()) return;
  console.log('Building backend...');
  await run(npmCommand, ['run', 'build'], { cwd: backendDir });
}

function isSourceNewerThanBackendBuild() {
  const buildTime = statSync(backendEntry).mtimeMs;
  return latestMtime(path.join(backendDir, 'src')) > buildTime
    || latestMtime(path.join(projectRoot, 'bin')) > buildTime;
}

function latestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let latest = statSync(dir).mtimeMs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      latest = Math.max(latest, latestMtime(entryPath));
    } else if (entry.isFile()) {
      latest = Math.max(latest, statSync(entryPath).mtimeMs);
    }
  }
  return latest;
}

function startBackend(args) {
  const port = readPort(args);
  const env = { ...process.env, ...(port ? { PORT: String(port) } : {}) };
  console.log(`Starting Bioflow agent service${port ? ` on port ${port}` : ''}...`);
  const child = spawn(process.execPath, ['--experimental-sqlite', backendEntry], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });

  forwardChildLifecycle(child);
}

function forwardChildLifecycle(child) {
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function readPort(args) {
  const portArg = args.find((arg) => arg.startsWith('--port='));
  if (portArg) {
    const value = Number(portArg.slice('--port='.length));
    if (!Number.isInteger(value) || value <= 0 || value > 65535) {
      console.error(`Invalid port: ${portArg}`);
      process.exit(1);
    }
    return value;
  }
  const index = args.findIndex((arg) => arg === '--port' || arg === '-p');
  if (index >= 0) {
    const value = Number(args[index + 1]);
    if (!Number.isInteger(value) || value <= 0 || value > 65535) {
      console.error(`Invalid port: ${args[index + 1] || ''}`);
      process.exit(1);
    }
    return value;
  }
  return null;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function printHelp() {
  console.log(`Bioflow CLI

Usage:
  bioflow [--port 3000]
  bioflow --help
  bioflow --version

Commands:
  start   Compatibility alias for bioflow.
  mcp     Manage MCP server configuration.
`);
}

async function manageMcp(args) {
  const [subcommand = 'help', ...rest] = args;
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printMcpHelp();
    return;
  }

  const options = parseOptions(rest);
  const configDir = resolveMcpConfigDir(options);
  const servers = readMcpServers(configDir);

  if (subcommand === 'list') {
    if (options.json) console.log(JSON.stringify(options['show-secrets'] ? servers : maskMcpSecrets(servers), null, 2));
    else printMcpList(servers, options.scope || 'project');
    return;
  }

  const name = options.positionals[0];
  if (!name) throw new Error(`mcp ${subcommand} requires a server name`);
  if (subcommand === 'get') {
    const server = servers.find((item) => item.id === name || item.name === name);
    if (!server) throw new Error(`MCP server not found: ${name}`);
    console.log(JSON.stringify(options['show-secrets'] ? server : maskMcpSecrets([server])[0], null, 2));
    return;
  }

  if (subcommand === 'add') {
    if (servers.some((item) => item.id === name || item.name === name)) {
      throw new Error(`MCP server already exists: ${name}. Use 'mcp remove ${name}' first.`);
    }
    const server = prepareMcpServerSecrets(buildMcpServer(name, options), configDir);
    servers.push(server);
    writeMcpServers(configDir, servers);
    console.log(`Added MCP server '${name}' to ${configDir}`);
    return;
  }

  if (subcommand === 'remove' || subcommand === 'rm') {
    const next = servers.filter((item) => item.id !== name && item.name !== name);
    if (next.length === servers.length) throw new Error(`MCP server not found: ${name}`);
    writeMcpServers(configDir, next);
    console.log(`Removed MCP server '${name}' from ${configDir}`);
    return;
  }

  throw new Error(`Unknown MCP command: ${subcommand}`);
}

function parseOptions(args) {
  const values = { positionals: [], arg: [], env: [], header: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      values.positionals.push(token);
      continue;
    }
    const [key, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (['json', 'disabled', 'show-secrets'].includes(key)) {
      values[key] = true;
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (['arg', 'env', 'header'].includes(key)) values[key].push(value);
    else values[key] = value;
  }
  return values;
}

function resolveMcpConfigDir(options) {
  if (options['config-dir']) return path.resolve(options['config-dir']);
  const scope = options.scope || 'project';
  if (scope === 'project') return path.join(backendDir, 'config');
  if (scope === 'local') return path.join(projectRoot, '.bioflow', 'config');
  if (scope === 'user') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || process.cwd(), '.config');
    return path.join(configHome, 'bioflow');
  }
  throw new Error(`Invalid scope '${scope}'. Expected project, local, or user.`);
}

function readMcpServers(configDir) {
  const target = path.join(configDir, 'mcp.json');
  if (!existsSync(target)) return [];
  const parsed = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
  const servers = Array.isArray(parsed) ? parsed : parsed?.servers;
  if (!Array.isArray(servers)) throw new Error(`Invalid MCP config: ${target}`);
  return servers;
}

function writeMcpServers(configDir, servers) {
  mkdirSync(configDir, { recursive: true });
  const target = path.join(configDir, 'mcp.json');
  const temporary = path.join(configDir, `.mcp.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ servers }, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
}

function buildMcpServer(name, options) {
  const transportType = options.transport || (options.url ? 'streamableHttp' : 'stdio');
  if (!['stdio', 'sse', 'streamableHttp'].includes(transportType)) {
    throw new Error("--transport must be stdio, sse, or streamableHttp");
  }
  if (transportType === 'stdio' && !options.command) throw new Error('stdio MCP servers require --command');
  if (transportType !== 'stdio' && !options.url) throw new Error(`${transportType} MCP servers require --url`);
  return {
    id: name,
    name,
    description: options.description || '',
    command: options.command || '',
    args: options.arg,
    env: keyValueOptions(options.env, '--env'),
    transportType,
    url: options.url || '',
    headers: keyValueOptions(options.header, '--header'),
    enabled: !options.disabled,
  };
}

function keyValueOptions(values, optionName) {
  const result = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error(`${optionName} must use NAME=value`);
    const key = value.slice(0, separator);
    const configuredValue = value.slice(separator + 1);
    result[key] = configuredValue;
  }
  return result;
}

function isSecretBearingKey(key) {
  return /key|token|secret|password|authorization/i.test(key);
}

function prepareMcpServerSecrets(server, configDir) {
  return {
    ...server,
    env: prepareSecretRecord(server.id, server.env, configDir),
    headers: prepareSecretRecord(server.id, server.headers, configDir),
  };
}

function prepareSecretRecord(serverId, values, configDir) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (!isSecretBearingKey(key) || !value || isEnvironmentReference(value)) return [key, value];
    const name = mcpCredentialEnvironmentName(serverId, key);
    persistEnvironmentSecret(getMcpEnvironmentFilePath(configDir), name, value);
    return [key, `\${${name}}`];
  }));
}

function isEnvironmentReference(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

function mcpCredentialEnvironmentName(serverId, fieldName) {
  const server = serverId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase() || 'SERVER';
  const field = fieldName.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase() || 'CREDENTIAL';
  return `BIOFLOW_MCP_${server}_${field}`;
}

function getMcpEnvironmentFilePath(configDir) {
  if (process.env.BIOFLOW_ENV_FILE) return path.resolve(process.env.BIOFLOW_ENV_FILE);
  if (path.resolve(configDir) === path.resolve(backendDir, 'config')) return path.join(backendDir, '.env');
  return path.join(path.dirname(configDir), '.env');
}

function persistEnvironmentSecret(target, name, value) {
  if (!value || /[\r\n]/.test(value)) throw new Error('Secret values must not be empty or contain a line break.');
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const assignment = `${name}=${JSON.stringify(value)}`;
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const assignmentPattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=.*$`, 'm');
  const next = assignmentPattern.test(existing)
    ? existing.replace(assignmentPattern, assignment)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${assignment}\n`;
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function printMcpList(servers, scope) {
  if (!servers.length) {
    console.log(`No MCP servers in ${scope} scope.`);
    return;
  }
  for (const server of servers) {
    const endpoint = server.transportType === 'stdio'
      ? [server.command, ...(server.args || [])].filter(Boolean).join(' ')
      : server.url;
    console.log(`${server.name || server.id}\t${server.enabled === false ? 'disabled' : 'enabled'}\t${server.transportType || 'stdio'}\t${endpoint}`);
  }
}

function maskMcpSecrets(servers) {
  return servers.map((server) => ({
    ...server,
    env: Object.fromEntries(Object.keys(server.env || {}).map((key) => [key, '***'])),
    headers: Object.fromEntries(Object.keys(server.headers || {}).map((key) => [key, '***'])),
  }));
}

function printMcpHelp() {
  console.log(`Bioflow MCP CLI

Usage:
  bioflow mcp list [--scope project|local|user] [--json] [--show-secrets]
  bioflow mcp get <name> [--scope project|local|user] [--show-secrets]
  bioflow mcp add <name> --command <command> [--arg <arg>]... [--env NAME=value]...
  bioflow mcp add <name> --url <url> [--transport sse|streamableHttp] [--header NAME=value]...
  bioflow mcp remove <name> [--scope project|local|user]

Options:
  --scope <scope>       project (default), local, or user
  --config-dir <path>   Use an explicit config directory instead of --scope
  --description <text>  Optional server description
  --disabled            Add the server disabled
  --show-secrets        Print unmasked config values; managed secrets remain references

Literal values in secret-bearing --env / --header fields are stored in a local
environment file and replaced by \${NAME} in mcp.json. Use \${NAME} yourself
to reference an existing environment variable.`);
}
