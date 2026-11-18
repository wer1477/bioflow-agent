import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECK_TIMEOUT_MS = 5_000;
const LOCAL_LOCATION = 'wsl';

export function createChecker(environment = process.env) {
  const effectiveEnvironment = withBioagentEnvironment(environment);
  return {
    command(name) {
      const executable = findCommand(name, effectiveEnvironment);
      if (!executable) return { status: 'missing', path: null, version: null };
      const result = spawnSync(executable, ['--version'], {
        env: effectiveEnvironment,
        encoding: 'utf8',
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: 32 * 1024,
      });
      const version = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/, 1)[0] || null;
      return { status: 'available', path: executable, version };
    },
    rPackages(packages) {
      const executable = findCommand('Rscript', effectiveEnvironment);
      if (!executable) return Object.fromEntries(packages.map((name) => [name, null]));
      const source = [
        `packages <- c(${packages.map((name) => JSON.stringify(name)).join(', ')})`,
        'for (item in packages) {',
        '  if (requireNamespace(item, quietly = TRUE)) cat(item, "\\t", as.character(utils::packageVersion(item)), "\\n", sep = "")',
        '  else cat(item, "\\t\\n", sep = "")',
        '}',
      ].join('\n');
      const result = spawnSync(executable, ['--vanilla', '-e', source], {
        env: effectiveEnvironment,
        encoding: 'utf8',
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: 32 * 1024,
      });
      if (result.status !== 0) return Object.fromEntries(packages.map((name) => [name, null]));
      const versions = Object.fromEntries(packages.map((name) => [name, null]));
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const [name, version] = line.split('\t', 2);
        if (name in versions) versions[name] = version || null;
      }
      return versions;
    },
  };
}

export function inspectProfile(profile, checker) {
  if (profile.location !== LOCAL_LOCATION) {
    return {
      schema_version: 1,
      profile: profileSummary(profile),
      status: 'server_required',
      checks: profile.commands.map((name) => ({
        id: `command:${name}`,
        kind: 'command',
        status: 'server_required',
        detail: `Required on ${profile.location}; this local diagnostic does not connect to remote hosts.`,
        path: null,
        version: null,
      })),
      provides: [],
    };
  }

  const checks = profile.commands.map((name) => {
    const result = checker.command(name);
    return {
      id: `command:${name}`,
      kind: 'command',
      status: result.status,
      detail: result.status === 'available' ? `Found ${result.path}` : 'Not found on the effective PATH.',
      path: result.path,
      version: result.version,
    };
  });
  const versions = checker.rPackages(profile.r_packages);
  for (const name of profile.r_packages) {
    const version = versions[name] || null;
    checks.push({
      id: `r-package:${name}`,
      kind: 'r_package',
      status: version ? 'available' : 'missing',
      detail: version ? `R package version ${version}` : 'Not installed in the Rscript environment.',
      path: null,
      version,
    });
  }
  const ready = checks.every((item) => item.status === 'available');
  return {
    schema_version: 1,
    profile: profileSummary(profile),
    status: ready ? 'available' : 'partial',
    checks,
    provides: ready ? profile.provides : [],
  };
}

export function profileSummary(profile) {
  return {
    id: profile.id,
    description: profile.description,
    location: profile.location,
    provides: profile.provides,
  };
}

function withBioagentEnvironment(environment) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const currentPath = environment[pathKey] || environment.PATH || '';
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const bioenvBin = environment.BIOAGENT_ENV_BIN || path.join(repositoryRoot, '.bioenv', 'bin');
  const entries = [isDirectory(bioenvBin) ? bioenvBin : null, ...currentPath.split(path.delimiter)].filter(Boolean);
  return { ...environment, [pathKey]: [...new Set(entries)].join(path.delimiter) };
}

function findCommand(name, environment) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const entries = String(environment[pathKey] || environment.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(environment.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of entries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* Continue searching. */ }
    }
  }
  return null;
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
