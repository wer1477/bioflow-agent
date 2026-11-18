// 工具卡片视图模型：把 trace item 归一成卡片可渲染的结构。
// 纯函数、无 React 依赖，保持可单测（与 domain/trace.js 同样的约定）。

/** 工具名 → 卡片类型。后端工具名见 agent-client/backend/src/agent/core_tools/ids.ts。 */
const CARD_BY_TOOL_NAME = {
  exec_command: 'terminal',
  shell_output: 'terminal',
  shell_kill: 'terminal',
  execute_python: 'code',
  read_file: 'file',
  write_file: 'file',
  edit_file: 'diff',
  apply_patch: 'diff',
  glob: 'search',
  grep: 'search',
  web_fetch: 'web',
  web_search: 'web',
  planning: 'plan',
  toollibrary: 'capability',
  toolload: 'capability',
  knowledgebase: 'capability',
};

/** 文件扩展名 → highlight.js 语言名。未登记的扩展名不高亮。 */
const LANGUAGE_BY_EXTENSION = {
  bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', css: 'css', cxx: 'cpp',
  h: 'c', hpp: 'cpp', hxx: 'cpp', js: 'javascript', json: 'json', jsx: 'javascript',
  md: 'markdown', mjs: 'javascript', py: 'python', r: 'r', rs: 'rust',
  sh: 'bash', ts: 'typescript', tsx: 'typescript', yaml: 'yaml', yml: 'yaml',
  zsh: 'bash',
};

/** 状态 → 状态点的语义档位。 */
const DOT_STATE_BY_STATUS = {
  running: 'running',
  completed: 'done',
  warning: 'warning',
  failed: 'error',
};

export function classifyToolCard(item = {}) {
  const title = String(item.title || '');
  const name = title.toLowerCase();

  // MCP 工具的公开名是 `<server>__<tool>`，没有固定工具名可查。
  if (name.includes('__')) return 'generic';
  if (CARD_BY_TOOL_NAME[name]) return CARD_BY_TOOL_NAME[name];

  // 兜底按 kind 判：plan / capability 即使工具名没登记也要能出卡片。
  if (item.kind === 'plan') return 'plan';
  if (item.kind === 'skill' || item.kind === 'mcp' || item.kind === 'coretool' || item.kind === 'knowledge') return 'capability';
  return 'generic';
}

export function dotStateFor(status) {
  return DOT_STATE_BY_STATUS[status] || 'idle';
}

/** 工具结果是结构化结果的 JSON 字符串；解析失败就当纯文本，不抛错。 */
export function parseToolOutput(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return String(value);
  }
}

/** 把任意值压成一行摘要：取首个非空行、折叠空白、超长截断。 */
export function summarizeValue(value, limit = 120) {
  if (value == null || value === '') return '';
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const firstLine = String(text)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '';
  const collapsed = firstLine.replace(/\s+/g, ' ');
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

export function formatBytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function languageForPath(path) {
  const name = String(path || '');
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || '';
}

export function baseName(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * 由 `edit_file` 的入参构造逐行差异。
 * 后端只回 `{path, replacements, size}`，真正的差异要靠入参的 old_string / new_string。
 */
export function buildEditDiff(input = {}) {
  const oldLines = splitLines(input.old_string);
  const newLines = splitLines(input.new_string);
  const removed = oldLines.filter((line) => !newLines.includes(line)).map((text) => ({ type: 'del', text }));
  const added = newLines.filter((line) => !oldLines.includes(line)).map((text) => ({ type: 'add', text }));
  const context = newLines.filter((line) => oldLines.includes(line)).map((text) => ({ type: 'ctx', text }));
  return {
    removed,
    added,
    context,
    additions: added.length,
    deletions: removed.length,
  };
}

function splitLines(value) {
  if (value == null || value === '') return [];
  return String(value).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/** unified diff 原文 → 带类型的行，用于 `apply_patch` 卡片。 */
export function parseUnifiedDiff(patch) {
  return String(patch || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line, index, all) => !(index === all.length - 1 && line === ''))
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return { type: 'meta', text: line };
      if (line.startsWith('@@')) return { type: 'hunk', text: line };
      if (line.startsWith('+')) return { type: 'add', text: line.slice(1) };
      if (line.startsWith('-')) return { type: 'del', text: line.slice(1) };
      return { type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
    });
}

export function toolCardModel(item = {}) {
  const card = classifyToolCard(item);
  const input = item.input && typeof item.input === 'object' ? item.input : {};
  const output = parseToolOutput(item.output);
  const structured = output && typeof output === 'object' ? output : {};
  const failed = item.status === 'failed' || structured.ok === false;
  const errorMessage = failed ? readError(structured) || summarizeValue(output) : '';

  const model = {
    card,
    status: item.status || 'completed',
    dotState: dotStateFor(failed ? 'failed' : item.status),
    title: item.title || 'Tool',
    subtitle: item.subtitle || '',
    summary: '',
    language: '',
    body: {},
    error: errorMessage,
    raw: item.raw,
  };
  // 工具结果不总是 JSON（例如异常路径直接回纯文本）。保留原文，
  // 让每张卡片都能兜底展示，而不是显示一片空白。
  const plainText = typeof output === 'string' ? output : '';

  if (card === 'terminal') {
    model.title = 'Terminal';
    model.subtitle = structured.cwd || input.cwd || '';
    model.summary = summarizeValue(structured.stdout) || summarizeValue(plainText) || exitLabel(structured);
    model.body = {
      command: structured.command || input.command || '',
      cwd: structured.cwd || input.cwd || '',
      stdout: text(structured.stdout) || plainText,
      stderr: text(structured.stderr),
      exitCode: structured.exit_code,
      timedOut: Boolean(structured.timedOut),
      truncated: Boolean(structured.stdout_truncated),
    };
    model.language = 'bash';
  } else if (card === 'code') {
    model.title = 'Python';
    model.summary = summarizeValue(structured.stdout) || summarizeValue(structured.resultPreview);
    model.body = {
      code: text(input.code),
      stdout: text(structured.stdout),
      stderr: text(structured.stderr),
      resultPreview: text(structured.resultPreview),
      session: structured.session || '',
      artifacts: Array.isArray(structured.artifacts) ? structured.artifacts : [],
    };
    model.language = 'python';
  } else if (card === 'file') {
    const path = structured.path || input.path || '';
    const action = String(item.title || '').toLowerCase() === 'write_file' ? 'write' : 'read';
    model.title = baseName(path) || (action === 'write' ? 'Write file' : 'Read file');
    model.subtitle = path;
    model.summary = action === 'write'
      ? formatBytes(structured.size)
      : [structured.returned_lines && structured.total_lines
        ? `${structured.returned_lines}/${structured.total_lines} 行`
        : structured.returned_lines ? `${structured.returned_lines} 行` : '',
        formatBytes(structured.size)].filter(Boolean).join(' · ');
    model.body = {
      action,
      path,
      content: text(structured.content),
      size: structured.size,
      returnedLines: structured.returned_lines,
      totalLines: structured.total_lines,
      truncated: Boolean(structured.truncated),
      encoding: structured.encoding || '',
    };
    model.language = languageForPath(path);
  } else if (card === 'diff') {
    const isPatch = String(item.title || '').toLowerCase() === 'apply_patch';
    if (isPatch) {
      const files = Array.isArray(structured.files) ? structured.files : [];
      const lines = parseUnifiedDiff(input.patch);
      model.title = files.length === 1 ? baseName(files[0].path) : 'Patch';
      model.subtitle = files.map((file) => file.path).filter(Boolean).join(', ') || structured.cwd || '';
      model.summary = `${files.length || 1} 个文件 · ${countDiff(lines)}`;
      model.body = { kind: 'patch', files, lines, cwd: structured.cwd || '' };
      model.language = 'diff';
    } else {
      const path = structured.path || input.path || '';
      const diff = buildEditDiff(input);
      model.title = baseName(path) || 'Edit file';
      model.subtitle = path;
      model.summary = `${countDiff([...diff.added, ...diff.removed])}${structured.replacements ? ` · ${structured.replacements} 处` : ''}`;
      model.body = { kind: 'edit', path, ...diff, replaceAll: Boolean(input.replace_all) };
      model.language = languageForPath(path);
    }
  } else if (card === 'search') {
    const isGlob = String(item.title || '').toLowerCase() === 'glob';
    const matches = Array.isArray(structured.matches) ? structured.matches : [];
    model.title = isGlob ? 'Files' : 'Search';
    model.subtitle = structured.pattern || structured.query || input.pattern || input.query || '';
    model.summary = `${structured.count ?? matches.length} 个结果`;
    model.body = { mode: isGlob ? 'glob' : 'grep', path: structured.path || '', matches };
  } else if (card === 'web') {
    model.title = structured.title || baseName(structured.url) || 'Web fetch';
    model.subtitle = structured.url || input.url || '';
    model.summary = [structured.status, structured.content_kind].filter(Boolean).join(' · ');
    model.body = {
      url: structured.url || input.url || '',
      status: structured.status,
      statusText: structured.statusText || '',
      title: structured.title || '',
      content: text(structured.content),
      contentKind: structured.content_kind || '',
      truncated: Boolean(structured.truncated),
    };
    model.language = 'markdown';
  } else if (card === 'plan') {
    const steps = readSteps(structured, input);
    model.title = item.title || 'Execution plan';
    model.subtitle = structured.title || '';
    model.summary = `${steps.length} 步`;
    model.body = { steps };
  } else if (card === 'capability') {
    model.title = item.title || 'Capability';
    model.subtitle = item.subtitle || '';
    model.summary = summarizeValue(structured.content || structured.result);
    model.body = { kind: item.kind || '', content: text(structured.content || structured.result) };
  } else {
    model.summary = summarizeValue(item.subtitle) || summarizeValue(structured);
    model.body = { input, output };
  }

  // 兜底：任何卡片在结构化字段缺失时，用纯文本结果补上摘要与正文。
  if (plainText) {
    model.body.plainText = plainText;
    if (!model.summary) model.summary = summarizeValue(plainText);
  }

  return model;
}

function readError(structured) {
  const error = structured?.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || error.code || summarizeValue(error);
}

function readSteps(structured, input) {
  const steps = structured?.steps || input?.steps;
  if (Array.isArray(steps)) return steps.map((step) => (typeof step === 'string' ? step : String(step?.text ?? step?.title ?? '')));
  return [];
}

function exitLabel(structured) {
  if (structured.timedOut) return '超时';
  if (structured.exit_code === undefined || structured.exit_code === null) return '';
  return `exit ${structured.exit_code}`;
}

function countDiff(lines) {
  const additions = lines.filter((line) => line.type === 'add').length;
  const deletions = lines.filter((line) => line.type === 'del').length;
  return `+${additions} −${deletions}`;
}

function text(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}
