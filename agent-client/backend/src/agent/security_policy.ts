import {
  getCoreToolRisk,
} from './core_tools_runtime.js';

export type SecurityMode = 'approval' | 'auto' | 'unrestricted';
export type CommandRisk = 'read_only' | 'project_write' | 'network_or_external' | 'destructive' | 'unknown';
export type SecurityDecision = 'allow' | 'ask' | 'classify';

export interface ToolSecurityAssessment {
  decision: SecurityDecision;
  risk: CommandRisk;
  reason: string;
}

/**
 * Policy guard inspired by Codex's known-safe/dangerous command heuristics.
 * It is deliberately not the Auto classifier: in Auto mode, non-trivial
 * actions are sent to a separate model reviewer after this guard runs.
 */
export function assessToolSecurity(
  mode: SecurityMode,
  toolName: string,
  args: Record<string, unknown>,
): ToolSecurityAssessment {
  if (mode === 'unrestricted') {
    return { decision: 'allow', risk: 'unknown', reason: 'Unrestricted mode is active.' };
  }

  const risk = classifyToolRisk(toolName, args);
  if (risk === 'read_only') {
    return { decision: 'allow', risk, reason: 'Recognized read-only operation.' };
  }
  if (mode === 'auto' && risk !== 'destructive') {
    return { decision: 'classify', risk, reason: 'Auto mode requires an independent model classification for this operation.' };
  }
  return {
    decision: 'ask',
    risk,
    reason: mode === 'approval'
      ? 'Approval mode requires confirmation for operations that are not recognized as read-only.'
      : `Auto classifier marked this operation as ${risk.replace(/_/g, ' ')}.`,
  };
}

export function normalizeSecurityMode(value: unknown): SecurityMode {
  return value === 'auto' || value === 'unrestricted' ? value : 'approval';
}

function classifyToolRisk(toolName: string, args: Record<string, unknown>): CommandRisk {
  const coreToolRisk = getCoreToolRisk(toolName);
  if (coreToolRisk === 'shell') return classifyShellCommand(String(args.cmd || ''));
  if (coreToolRisk === 'code_execution') return 'unknown';
  if (coreToolRisk) return coreToolRisk;
  // MCP tools can mutate remote or local state. Without provider-declared
  // metadata, an explicit confirmation is safer than assuming they are reads.
  return 'unknown';
}

function classifyShellCommand(command: string): CommandRisk {
  const trimmed = command.trim();
  if (!trimmed || hasShellControlSyntax(trimmed)) return 'unknown';
  const words = tokenizeSimpleCommand(trimmed);
  if (!words.length) return 'unknown';
  if (isDestructiveCommand(words)) return 'destructive';
  if (isExternalCommand(words)) return 'network_or_external';
  if (isKnownReadOnlyCommand(words)) return 'read_only';
  if (isKnownProjectWriteCommand(words)) return 'project_write';
  return 'unknown';
}

function hasShellControlSyntax(command: string): boolean {
  return /[;|&><`$()\n\\]/.test(command);
}

function tokenizeSimpleCommand(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

function isKnownReadOnlyCommand(words: string[]): boolean {
  const [program, ...args] = words;
  if (['pwd', 'ls', 'rg', 'grep', 'head', 'tail', 'wc', 'stat', 'file', 'which', 'df', 'du', 'uname', 'ps'].includes(program)) {
    if (program === 'rg' && args.some((arg) => ['--pre', '--search-zip', '-z'].includes(arg) || arg.startsWith('--pre='))) return false;
    return !containsSensitivePath(args);
  }
  if (program === 'cat') return !containsSensitivePath(args);
  if (program === 'find') return !args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint'].includes(arg));
  if (program === 'sed') return args.length <= 3 && args[0] === '-n' && /^(?:\d+|\d+,\d+)p$/.test(args[1] || '') && !containsSensitivePath(args.slice(2));
  if (program === 'git') return isReadOnlyGitCommand(args);
  if (['node', 'nodejs', 'python', 'python3', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'rustc'].includes(program)) {
    return args.length === 1 && ['--version', '-v', 'version'].includes(args[0]);
  }
  return false;
}

function isReadOnlyGitCommand(args: string[]): boolean {
  const subcommandIndex = args.findIndex((arg) => !arg.startsWith('-'));
  if (subcommandIndex < 0) return false;
  if (args.slice(0, subcommandIndex).some((arg) => ['-C', '-c', '-p'].includes(arg) || arg.startsWith('-C') || arg.startsWith('-c'))) return false;
  const subcommand = args[subcommandIndex];
  const rest = args.slice(subcommandIndex + 1);
  if (['status', 'log', 'diff', 'show', 'rev-parse'].includes(subcommand)) return !rest.some((arg) => arg === '--no-index' || arg === '--output');
  if (subcommand !== 'branch') return false;
  return rest.length === 0 || rest.every((arg) => ['--list', '-l', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose'].includes(arg) || arg.startsWith('--format='));
}

function containsSensitivePath(values: string[]): boolean {
  return values.some((value) => /(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials|secrets?)(?:$|\/)/i.test(value) || /\/etc\/shadow/.test(value));
}

function isKnownProjectWriteCommand(words: string[]): boolean {
  const [program, first, second] = words;
  if (['npm', 'pnpm', 'yarn'].includes(program)) {
    return ['test', 'run'].includes(first || '') && (first !== 'run' || ['test', 'build', 'lint', 'check', 'typecheck'].includes(second || ''));
  }
  if (program === 'cargo') return ['test', 'build', 'check', 'fmt', 'clippy'].includes(first || '');
  if (program === 'go') return first === 'test';
  if (['pytest', 'jest', 'vitest'].includes(program)) return first === undefined || first.startsWith('-');
  if (program === 'make') return ['test', 'build', 'check'].includes(first || '');
  return false;
}

function isExternalCommand(words: string[]): boolean {
  const [program, ...args] = words;
  if (['curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp'].includes(program)) return true;
  if (['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'uv', 'cargo'].includes(program)) return ['install', 'add', 'publish', 'login', 'logout'].includes(args[0] || '');
  if (program === 'git') return ['push', 'fetch', 'pull', 'clone', 'remote'].includes(args.find((arg) => !arg.startsWith('-')) || '');
  return false;
}

function isDestructiveCommand(words: string[]): boolean {
  const [program, ...args] = words;
  if (['sudo', 'su', 'doas', 'chmod', 'chown', 'dd', 'mkfs', 'mount', 'umount', 'shutdown', 'reboot', 'poweroff'].includes(program)) return true;
  if (program === 'rm' || program === 'rmdir' || program === 'unlink') return true;
  if (program === 'git') {
    const subcommand = args.find((arg) => !arg.startsWith('-')) || '';
    return subcommand === 'reset' && args.includes('--hard')
      || subcommand === 'clean'
      || subcommand === 'push' && args.some((arg) => ['--force', '-f'].includes(arg))
      || subcommand === 'branch' && args.some((arg) => ['-D', '--delete', '--force'].includes(arg));
  }
  if (['kubectl', 'terraform', 'docker', 'podman'].includes(program)) {
    return args.some((arg) => ['delete', 'destroy', 'rm', 'prune', 'system'].includes(arg));
  }
  return /\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i.test(words.join(' '));
}
