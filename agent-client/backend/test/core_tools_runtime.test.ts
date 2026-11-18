import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPLY_PATCH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  EXEC_COMMAND_TOOL_NAME,
  FILE_CORE_TOOL_ID,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_KILL_TOOL_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  KNOWLEDGEBASE_TOOL_NAME,
  TOOLLIBRARY_CORE_TOOL_ID,
  TOOLLIBRARY_TOOL_NAME,
  TOOLLOAD_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  buildAllCoreTools,
  buildCoreToolsForIds,
  buildCoreToolsPrompt,
  executeCoreTool,
  getCoreToolRisk,
  getRegisteredCoreTools,
  isCoreToolCall,
  isParallelizableCoreTool,
  isToolLibraryCoreTool,
} from '../src/agent/core_tools_runtime.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';
import { configureBioagentRuntimeEnvironment } from '../src/runtime_environment.js';
import { assessToolSecurity } from '../src/agent/security_policy.js';

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bioflow-coretools-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Path-based tools are rooted at a project directory; these tests share one
// throwaway project so relative-path behaviour stays realistic.
const toolProject = createTempProject('core-tools');
after(() => toolProject.cleanup());

async function callTool(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(await executeCoreTool(toolName, args, { projectPath: toolProject.projectPath })) as Record<string, unknown>;
}

/** Tool errors are strings for legacy tools and `{code, message}` objects for the hardened ones. */
function errorMessage(result: Record<string, unknown>): string {
  const error = result.error as unknown;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

async function withMockFetch<T>(response: Response, callback: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createTextPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const startXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('grep treats a leading dash query as literal text', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'values.txt');
    await writeFile(file, 'before\n-1\nafter\n');

    const result = await callTool(GREP_TOOL_NAME, { query: '-1', path: directory, case_sensitive: true });

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal((result.matches as Array<Record<string, unknown>>)[0]?.preview, '-1');
  });
});

test('exec_command rejects an already-aborted execution signal', async () => {
  const controller = new AbortController();
  controller.abort();
  const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
  await assert.rejects(
    executeCoreTool(EXEC_COMMAND_TOOL_NAME, { cmd: command }, { abortSignal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('exec_command defaults to the project directory bound to the session', async () => {
  const project = createTempProject('core-tools-cwd');
  const conversation = createConversation({ title: 'core tools cwd', projectPath: project.projectPath });
  try {
    const result = JSON.parse(await executeCoreTool(EXEC_COMMAND_TOOL_NAME, { cmd: 'pwd' }, { conversationId: conversation.id, projectPath: project.projectPath })) as Record<string, unknown>;

    assert.equal(result.ok, true);
    assert.equal(result.cwd, project.projectPath);
    assert.equal(String(result.stdout).trim(), project.projectPath);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('exec_command makes the running Node binary directory available on PATH', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/usr/bin';
  try {
    const result = await callTool(EXEC_COMMAND_TOOL_NAME, { cmd: 'node -p "process.env.PATH"' });
    assert.equal(result.ok, true);
    assert.match(String(result.stdout), new RegExp(path.dirname(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    process.env.PATH = originalPath;
  }
});

test('runtime startup registers the repository Bioagent environment', () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const environment: NodeJS.ProcessEnv = {};

  configureBioagentRuntimeEnvironment(environment, repositoryRoot);

  assert.equal(environment.BIOAGENT_ENV_BIN, path.join(repositoryRoot, '.bioenv', 'bin'));
});

test('exec_command makes the configured Bioagent environment available on PATH', async () => {
  const originalPath = process.env.PATH;
  const originalBioenvBin = process.env.BIOAGENT_ENV_BIN;
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  process.env.PATH = '/usr/bin';
  process.env.BIOAGENT_ENV_BIN = path.join(repositoryRoot, '.bioenv', 'bin');
  try {
    const result = await callTool(EXEC_COMMAND_TOOL_NAME, { cmd: 'Rscript --version' });
    assert.equal(result.ok, true);
    assert.match(String(result.stdout), /version 4\.4/i);
  } finally {
    process.env.PATH = originalPath;
    if (originalBioenvBin === undefined) delete process.env.BIOAGENT_ENV_BIN;
    else process.env.BIOAGENT_ENV_BIN = originalBioenvBin;
  }
});

test('web_fetch marks bot challenges instead of treating them as readable pages', async () => {
  const response = new Response('<html><title>Checking your browser - reCAPTCHA</title><body>Checking your browser before accessing this site.</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  await withMockFetch(response, async () => {
    const result = await callTool(WEB_FETCH_TOOL_NAME, { url: 'https://example.test/article' });
    assert.equal(result.ok, true);
    assert.equal(result.content_kind, 'html');
    assert.equal(result.access_status, 'bot_challenge');
    assert.equal(result.extraction_method, 'html_to_text');
  });
});

test('web_fetch extracts readable sections from JATS XML', async () => {
  const response = new Response(`<?xml version="1.0"?>
    <article><front><article-meta><title-group><article-title>Evidence paper</article-title></title-group><abstract><p>Summary evidence.</p></abstract></article-meta></front>
    <body><sec id="methods"><title>Methods</title><p>Sequencing used paired-end reads.</p></sec><sec id="results"><title>Results</title><p>Expression increased.</p></sec></body></article>`, {
    status: 200,
    headers: { 'content-type': 'application/xml' },
  });
  await withMockFetch(response, async () => {
    const result = await callTool(WEB_FETCH_TOOL_NAME, { url: 'https://example.test/fulltext.xml' });
    assert.equal(result.ok, true);
    assert.equal(result.content_kind, 'xml');
    assert.equal(result.access_status, 'available');
    assert.equal(result.extraction_method, 'jats_xml');
    assert.equal(result.title, 'Evidence paper');
    assert.match(String(result.content), /Summary evidence/);
    assert.deepEqual(result.sections, [
      { title: 'Methods', content: 'Sequencing used paired-end reads.' },
      { title: 'Results', content: 'Expression increased.' },
    ]);
  });
});

test('web_fetch extracts text and page count from PDFs', async () => {
  const response = new Response(createTextPdf('PDF evidence text'), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
  await withMockFetch(response, async () => {
    const result = await callTool(WEB_FETCH_TOOL_NAME, { url: 'https://example.test/article.pdf' });
    assert.equal(result.ok, true);
    assert.equal(result.content_kind, 'pdf');
    assert.equal(result.access_status, 'available');
    assert.equal(result.extraction_method, 'pdf-parse');
    assert.equal(result.page_count, 1);
    assert.match(String(result.content), /PDF evidence text/);
  });
});

test('edit_file matches read_file LF text and preserves CRLF files', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'crlf.txt');
    await writeFile(file, 'alpha\r\nbeta\r\n');

    const result = await callTool(EDIT_FILE_TOOL_NAME, {
      file_path: file,
      old_string: 'alpha\nbeta',
      new_string: 'alpha\ngamma',
    });

    assert.equal(result.ok, true);
    assert.equal(await readFile(file, 'utf8'), 'alpha\r\ngamma\r\n');
  });
});

test('file tool schemas expose the implemented workdir parameter', () => {
  const tools = buildCoreToolsForIds([FILE_CORE_TOOL_ID]);
  const fileTools = tools.filter((tool) => ['read_file', 'write_file', 'edit_file'].includes(tool.function.name));

  assert.equal(fileTools.length, 3);
  for (const tool of fileTools) {
    const parameters = tool.function.parameters as { properties: Record<string, unknown> };
    assert.ok('workdir' in parameters.properties, `${tool.function.name} should declare workdir`);
  }
});

test('the CoreTool registry supplies the toollibrary schemas, prompt, dispatch, and risk metadata', () => {
  const definition = getRegisteredCoreTools().find((tool) => tool.id === TOOLLIBRARY_CORE_TOOL_ID);
  assert.ok(definition);

  const tools = buildCoreToolsForIds([TOOLLIBRARY_CORE_TOOL_ID]);
  assert.deepEqual(tools.map((tool) => tool.function.name), [TOOLLIBRARY_TOOL_NAME, TOOLLOAD_TOOL_NAME]);

  const browse = tools[0]?.function.parameters as any;
  assert.ok(browse.properties.domain, 'browsing needs a domain selector');
  assert.ok(browse.properties.offset);
  assert.ok(browse.properties.limit);
  assert.equal(browse.additionalProperties, false);

  const load = tools[1]?.function.parameters as any;
  assert.ok(load.properties.id, 'loading needs a capability id');
  assert.ok(load.properties.resource, 'loading needs an MCP resource selector');
  assert.ok(load.properties.server);
  assert.equal(load.additionalProperties, false);

  const browseDescription = String(tools[0]?.function.description);
  assert.match(browseDescription, /two-level tool library/);
  assert.match(browseDescription, /toolload/);
  assert.match(browseDescription, /<tool_library_domains>/);
  assert.doesNotMatch(browseDescription, /Omit domain to load the domain index/);
  assert.doesNotMatch(browseDescription, /<mcp_catalog>/);
  assert.doesNotMatch(browseDescription, /<default_skill_catalog>/);
  assert.match(String(tools[1]?.function.description), /SKILL\.md body/);

  assert.match(buildCoreToolsPrompt([TOOLLIBRARY_CORE_TOOL_ID]) || '', /Tool library is enabled/);
  assert.match(buildCoreToolsPrompt([TOOLLIBRARY_CORE_TOOL_ID]) || '', /<tool_library_domains>/);
  assert.equal(isCoreToolCall(TOOLLIBRARY_TOOL_NAME), true);
  assert.equal(isCoreToolCall(TOOLLOAD_TOOL_NAME), true);
  assert.equal(isToolLibraryCoreTool(TOOLLIBRARY_TOOL_NAME), true);
  assert.equal(isToolLibraryCoreTool(TOOLLOAD_TOOL_NAME), true);
  assert.equal(getCoreToolRisk(TOOLLOAD_TOOL_NAME), 'read_only');
  assert.equal(assessToolSecurity('approval', TOOLLIBRARY_TOOL_NAME, {}).decision, 'allow');
  assert.equal(assessToolSecurity('approval', TOOLLOAD_TOOL_NAME, {}).decision, 'allow');
});

test('the CoreTool registry supplies knowledgebase schema, prompt, dispatch, and risk metadata', () => {
  const definition = getRegisteredCoreTools().find((tool) => tool.id === KNOWLEDGEBASE_TOOL_NAME);
  assert.ok(definition);

  const tools = buildCoreToolsForIds([KNOWLEDGEBASE_TOOL_NAME]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.function.name, KNOWLEDGEBASE_TOOL_NAME);
  const description = String(tools[0]?.function.description);
  assert.match(description, /action="select"/);
  assert.match(description, /action="index"/);
  assert.match(description, /action="catalog"/);
  assert.match(description, /action="read"/);
  assert.match(description, /never contain executable scripts/);
  assert.doesNotMatch(description, /<default_skill_catalog>/);
  assert.match(buildCoreToolsPrompt([KNOWLEDGEBASE_TOOL_NAME]) || '', /Knowledge Base is enabled/);

  assert.equal(isCoreToolCall(KNOWLEDGEBASE_TOOL_NAME), true);
  assert.equal(isToolLibraryCoreTool(KNOWLEDGEBASE_TOOL_NAME), false);
  assert.equal(getCoreToolRisk(KNOWLEDGEBASE_TOOL_NAME), 'read_only');
  assert.equal(isParallelizableCoreTool(KNOWLEDGEBASE_TOOL_NAME), true);
  assert.equal(definition?.risk, 'read_only');
  assert.equal(assessToolSecurity('approval', KNOWLEDGEBASE_TOOL_NAME, {}).decision, 'allow');

  const parameters = tools[0]?.function.parameters as any;
  assert.deepEqual(parameters.properties.action.enum, ['select', 'index', 'catalog', 'read']);
  // Defaulting the action is what makes "hand selection to biod" the default path.
  assert.equal(parameters.required, undefined);
  assert.match(String(parameters.properties.action.description), /Defaults to select/);
  assert.ok(parameters.properties.domain);
  assert.ok(parameters.properties.entry);
});

test('executeCoreTool dispatches knowledgebase actions through the CoreTool entry point', async () => {
  const result = await callTool(KNOWLEDGEBASE_TOOL_NAME, { action: 'index' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'index');
  assert.ok(Array.isArray(result.domains));

  const unknown = await callTool(KNOWLEDGEBASE_TOOL_NAME, { action: 'delete' });
  assert.equal(unknown.ok, false);
  assert.match(errorMessage(unknown), /Unknown knowledgebase action/);
});

test('executeCoreTool applies the agent knowledge entry scope on the parallel path', async () => {
  const agent = { id: 'main', knowledgeEntryIds: ['Bioinformatics/pysam'] } as any;
  const index = JSON.parse(await executeCoreTool(KNOWLEDGEBASE_TOOL_NAME, { action: 'index' }, { agent })) as Record<string, any>;
  assert.deepEqual(index.domains.map((domain: { name: string }) => domain.name), ['Bioinformatics']);
  assert.equal(index.domains[0]?.entries, 1);

  const blocked = JSON.parse(await executeCoreTool(KNOWLEDGEBASE_TOOL_NAME, { action: 'read', entry: 'Bioinformatics/anndata' }, { agent })) as Record<string, unknown>;
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error), /is not enabled for this agent/);
});

test('the runtime CoreTool surface always includes every registered tool', () => {
  const registeredToolNames = getRegisteredCoreTools().flatMap((tool) => tool.toolNames).sort();
  const loadedToolNames = buildAllCoreTools().map((tool) => tool.function.name).sort();

  assert.deepEqual(loadedToolNames, registeredToolNames);
});

test('read_file cursor reflects complete lines actually returned before character truncation', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'many-lines.txt');
    await writeFile(file, Array.from({ length: 100 }, (_, index) => `${index + 1}:${'x'.repeat(90)}`).join('\n'));

    const result = await callTool(READ_FILE_TOOL_NAME, { file_path: file, limit: 100, max_chars: 1_000 });
    const visibleLines = String(result.content).split('\n').filter(Boolean);

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.returned_lines, visibleLines.length);
    assert.equal(result.next_offset, visibleLines.length + 1);
    assert.ok(visibleLines.length < 100);
  });
});

test('read_file rejects an offset beyond EOF', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'short.txt');
    await writeFile(file, 'one\ntwo\n');

    const result = await callTool(READ_FILE_TOOL_NAME, { file_path: file, offset: 100 });

    assert.equal(result.ok, false);
    assert.match(errorMessage(result), /beyond end of file/i);
  });
});

test('read_file rejects a line that cannot fit within max_chars without buffering it whole', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'long-line.txt');
    await writeFile(file, 'x'.repeat(1_000_000));

    const result = await callTool(READ_FILE_TOOL_NAME, { file_path: file, max_chars: 1_000 });

    assert.equal(result.ok, false);
    assert.match(errorMessage(result), /Line 1 exceeds max_chars/i);
  });
});

test('grep rejects an oversized ripgrep JSON record instead of retaining it unboundedly', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'minified.json');
    await writeFile(file, `needle${'x'.repeat(100_000)}`);

    const result = await callTool(GREP_TOOL_NAME, { query: 'needle', path: directory, case_sensitive: true });

    assert.equal(result.ok, false);
    assert.match(errorMessage(result), /output record exceeds/i);
  });
});

test('apply_patch uses the hunk line anchor when identical context appears earlier', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'duplicate-context.txt');
    await writeFile(file, 'same\nkeep\nsame\nkeep\n');

    const result = await callTool(APPLY_PATCH_TOOL_NAME, {
      workdir: directory,
      patch: '--- a/duplicate-context.txt\n+++ b/duplicate-context.txt\n@@ -3,2 +3,2 @@\n same\n-keep\n+changed\n',
    });

    assert.equal(result.ok, true);
    assert.equal(await readFile(file, 'utf8'), 'same\nkeep\nsame\nchanged\n');
  });
});

test('apply_patch rejects ambiguous fallback context when the hunk line anchor no longer matches', async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, 'ambiguous-context.txt');
    await writeFile(file, 'same\nkeep\nsame\nkeep\n');

    const result = await callTool(APPLY_PATCH_TOOL_NAME, {
      workdir: directory,
      patch: '--- a/ambiguous-context.txt\n+++ b/ambiguous-context.txt\n@@ -99,2 +99,2 @@\n same\n-keep\n+changed\n',
    });

    assert.equal(result.ok, false);
    assert.match(errorMessage(result), /ambiguous/i);
    assert.equal(await readFile(file, 'utf8'), 'same\nkeep\nsame\nkeep\n');
  });
});

test('apply_patch rejects deletion of a file that does not exist', async () => {
  await withTemporaryDirectory(async (directory) => {
    const result = await callTool(APPLY_PATCH_TOOL_NAME, {
      workdir: directory,
      patch: '--- a/missing.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-missing\n',
    });

    assert.equal(result.ok, false);
    assert.match(errorMessage(result), /does not exist/i);
  });
});

test('shell background task tools are registered with the expected risk and schema', () => {
  const names = getRegisteredCoreTools().flatMap((tool) => tool.toolNames);
  assert.ok(names.includes(SHELL_OUTPUT_TOOL_NAME));
  assert.ok(names.includes(SHELL_KILL_TOOL_NAME));

  const tools = buildAllCoreTools().filter((tool) => [SHELL_OUTPUT_TOOL_NAME, SHELL_KILL_TOOL_NAME].includes(tool.function.name));
  assert.equal(tools.length, 2);
  const output = tools.find((tool) => tool.function.name === SHELL_OUTPUT_TOOL_NAME)!;
  const outputParams = output.function.parameters as any;
  assert.ok(outputParams.properties.task_id);
  assert.ok(outputParams.properties.offset);
  assert.ok(outputParams.properties.wait_ms);

  const exec = buildAllCoreTools().find((tool) => tool.function.name === EXEC_COMMAND_TOOL_NAME)!;
  assert.ok((exec.function.parameters as any).properties.run_in_background);

  assert.equal(getCoreToolRisk(SHELL_OUTPUT_TOOL_NAME), 'read_only');
  assert.equal(isParallelizableCoreTool(SHELL_OUTPUT_TOOL_NAME), true);
  assert.equal(getCoreToolRisk(SHELL_KILL_TOOL_NAME), 'shell');
  assert.equal(isParallelizableCoreTool(SHELL_KILL_TOOL_NAME), false);
});

test('web_search is a network CoreTool dispatched by the runtime, not the core executor', () => {
  const names = getRegisteredCoreTools().flatMap((tool) => tool.toolNames);
  assert.ok(names.includes(WEB_SEARCH_TOOL_NAME));
  const tool = buildAllCoreTools().find((entry) => entry.function.name === WEB_SEARCH_TOOL_NAME);
  assert.ok(tool);
  const parameters = tool!.function.parameters as any;
  assert.equal(parameters.required?.[0], 'query');
  assert.ok(parameters.properties.max_results);
  assert.equal(getCoreToolRisk(WEB_SEARCH_TOOL_NAME), 'network_or_external');
  assert.equal(isCoreToolCall(WEB_SEARCH_TOOL_NAME), true);
});

test('grep schema exposes context, paging and output-mode parameters', () => {
  const tool = buildAllCoreTools().find((entry) => entry.function.name === GREP_TOOL_NAME)!;
  const parameters = tool.function.parameters as any;
  for (const key of ['context', 'head_limit', 'offset', 'output_mode', 'type']) {
    assert.ok(parameters.properties[key], `grep should declare ${key}`);
  }
});

test('edit_file schema accepts a multiple-edit array and read_file accepts a PDF page range', () => {
  const edit = buildAllCoreTools().find((entry) => entry.function.name === EDIT_FILE_TOOL_NAME)!;
  const editParameters = edit.function.parameters as any;
  assert.ok(editParameters.properties.edits);
  assert.equal(editParameters.required?.includes('old_string'), false);

  const read = buildAllCoreTools().find((entry) => entry.function.name === READ_FILE_TOOL_NAME)!;
  assert.ok((read.function.parameters as any).properties.pages);
});

test('file writes enforce read-before-write inside a conversation', async () => {
  const project = createTempProject('core-tools-read-before-write');
  const conversation = createConversation({ title: 'read before write', projectPath: project.projectPath });
  try {
    const file = path.join(project.projectPath, 'note.txt');
    await writeFile(file, 'first version\n');
    const unread = JSON.parse(await executeCoreTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'overwrite\n' }, {
      conversationId: conversation.id,
      projectPath: project.projectPath,
    })) as Record<string, unknown>;
    assert.equal(unread.ok, false);
    assert.equal((unread.error as any).code, 'FS_NOT_OBSERVED');

    const read = JSON.parse(await executeCoreTool(READ_FILE_TOOL_NAME, { file_path: file }, {
      conversationId: conversation.id,
      projectPath: project.projectPath,
    })) as Record<string, unknown>;
    assert.equal(read.ok, true);

    const written = JSON.parse(await executeCoreTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'second version\n' }, {
      conversationId: conversation.id,
      projectPath: project.projectPath,
    })) as Record<string, unknown>;
    assert.equal(written.ok, true);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
