import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import {
  SKILL_RESOURCE_INLINE_BUDGET,
  TOOLLIBRARY_CATALOG_CHAR_BUDGET,
  UNCLASSIFIED_DOMAIN_NAME,
  buildCatalogState,
  executeToolLibraryBrowse,
  executeToolLoad,
  readDomainIndex,
  renderToolLibraryDomainIndexPrompt,
  type ToolLibraryContext,
  type ToolLibrarySkill,
} from '../src/agent/core_tools/toollibrary_executor.js';
import type { CatalogServerEntry } from '../src/agent/types.js';

async function withLibrary(files: Record<string, string>, callback: (root: string) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bioflow-toollibrary-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
    }
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function skill(id: string, name = id, description = `${name} description`): ToolLibrarySkill {
  return { id, name, description, instructions: `Use ${name}.`, resources: [], directory: '' };
}

function mcpTool(id: string, description = `${id} description`): ChatCompletionTool {
  return { type: 'function', function: { name: id, description, parameters: { type: 'object', properties: {} } } };
}

function server(name: string, toolIds: string[]): CatalogServerEntry {
  return {
    name,
    instructions: '',
    tools: toolIds.map((id) => ({ kind: 'mcp_tool' as const, id, server: name, toolName: id.slice(name.length + 2), description: `${id} description` })),
    resources: [],
  };
}

function context(root: string, options: {
  skills?: ToolLibrarySkill[];
  servers?: CatalogServerEntry[];
  tools?: Map<string, ChatCompletionTool>;
} = {}): ToolLibraryContext {
  const servers = options.servers ?? [];
  const mcpTools = options.tools ?? new Map(servers.flatMap((entry) => entry.tools.map((tool) => [tool.id, mcpTool(tool.id, tool.description)] as const)));
  return { root, skills: options.skills ?? [], mcpServers: servers, mcpTools };
}

test('index merges the root index with disk domains, drops ghosts and reports unlisted capabilities', async () => {
  await withLibrary({
    'index.md': '# 领域\n\n- 分析：分析领域\n- 幽灵：不存在的领域\n\n',
    '分析/index.md': [
      '# 分析', '',
      '- 甲（skill：a）：第一个', '- 乙（skill：b）：第二个', '',
    ].join('\n'),
    '额外/index.md': '- 丙（skill：c）：第三个\n',
    '空领域/index.md': '# 空领域\n',
  }, async (root) => {
    const result = executeToolLibraryBrowse({}, context(root, {
      skills: [skill('a', '甲'), skill('b', '乙'), skill('c', '丙'), skill('d', '丁')],
    }));

    assert.equal(result.ok, true);
    assert.equal(result.action, 'index');
    const domains = result.domains as Array<{ name: string; description: string; tools: number }>;
    assert.deepEqual(domains.map((domain) => domain.name), ['分析', '额外', UNCLASSIFIED_DOMAIN_NAME]);
    assert.deepEqual(domains[0], { name: '分析', description: '分析领域', tools: 2 });
    assert.deepEqual(domains[1], { name: '额外', description: '', tools: 1 });
    assert.deepEqual(domains[2], {
      name: UNCLASSIFIED_DOMAIN_NAME,
      description: 'Runtime fallback domain: capabilities that are configured or connected but not yet listed in any domain index file.',
      tools: 1,
    });

    const warnings = result.warnings as string[];
    assert.ok(warnings.some((warning) => warning.startsWith('unknown_domain:')));
    assert.ok(warnings.some((warning) => warning.startsWith('unlisted_domain:')));
    assert.ok(warnings.some((warning) => warning.startsWith('unlisted_tool:')));
  });
});

test('the prompt renderer mirrors the L1 index order and appends unlisted disk domains', async () => {
  await withLibrary({
    'index.md': '# 领域\n\n- 分析：分析领域\n- 幽灵：不存在的领域\n- 额外：额外领域\n',
    '分析/index.md': '- 甲（skill：a）：第一个\n',
    '额外/index.md': '- 乙（skill：b）：第二个\n',
    '未列出/index.md': '- 丙（skill：c）：第三个\n',
  }, async (root) => {
    const prompt = renderToolLibraryDomainIndexPrompt(root);
    assert.ok(prompt);
    const lines = prompt.split('\n');
    assert.equal(lines[0], '<tool_library_domains>');
    assert.equal(lines[lines.length - 1], '</tool_library_domains>');
    assert.deepEqual(
      lines.filter((line) => line.startsWith('- ')),
      ['- 分析：分析领域', '- 额外：额外领域', '- 未列出'],
    );
    assert.doesNotMatch(prompt, /\b\d+ tools?\b/, 'the prompt must not invent tool counts');
    assert.doesNotMatch(prompt, /幽灵/);

    // The fallback L1 action and the prompt must agree on the domain list.
    const index = executeToolLibraryBrowse({}, context(root, {
      skills: [skill('a'), skill('b'), skill('c')],
    }));
    assert.deepEqual(
      (index.domains as Array<{ name: string }>).map((domain) => domain.name),
      ['分析', '额外', '未列出'],
    );
  });
});

test('the prompt renderer returns null instead of failing when the display layer is absent', async () => {
  const missing = path.join(os.tmpdir(), `bioflow-missing-library-prompt-${process.pid}`);
  assert.equal(renderToolLibraryDomainIndexPrompt(missing), null);

  // Domains on disk but no root index: the rows still render without descriptions.
  await withLibrary({ '领域/index.md': '- 甲（skill：a）：一\n' }, async (root) => {
    const prompt = renderToolLibraryDomainIndexPrompt(root);
    assert.ok(prompt);
    assert.match(prompt, /- 领域\n/);
  });

  const empty = await mkdtemp(path.join(os.tmpdir(), 'bioflow-empty-library-'));
  try {
    assert.equal(renderToolLibraryDomainIndexPrompt(empty), null);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('the prompt renderer drops domains the agent has no capability in', async () => {
  await withLibrary({
    'index.md': '- 分析：分析领域\n- 临床：临床领域\n- 空转：没人用的领域\n',
    '分析/index.md': '- 甲（skill：a）：第一个\n',
    '临床/index.md': '- 乙（skill：b）：第二个\n- 丙（mcp：acme_search）：第三个\n',
    '空转/index.md': '- 丁（skill：d）：第四个\n',
  }, async (root) => {
    // A skill binding keeps exactly its own domain.
    const skillsOnly = renderToolLibraryDomainIndexPrompt(root, { skillIds: ['a'], mcpServerIds: [] });
    assert.ok(skillsOnly);
    assert.match(skillsOnly, /- 分析：分析领域/);
    assert.doesNotMatch(skillsOnly, /临床|空转/);

    // An MCP entry keeps its domain alive through its server binding: the catalog id is the
    // public tool name, so the server is matched by prefix, not by the full name.
    const mcpOnly = renderToolLibraryDomainIndexPrompt(root, { skillIds: [], mcpServerIds: ['acme'] });
    assert.ok(mcpOnly);
    assert.match(mcpOnly, /- 临床：临床领域/);
    assert.doesNotMatch(mcpOnly, /分析|空转/);

    // A bound skill that no entry mentions cannot resurrect the domain it belongs to.
    const unlistedSkill = renderToolLibraryDomainIndexPrompt(root, { skillIds: ['d'], mcpServerIds: [] });
    assert.ok(unlistedSkill, 'the domain that lists the skill still renders');
    assert.match(unlistedSkill, /- 空转：没人用的领域/);

    // Nothing bound anywhere: no block at all, so the caller drops the prompt section.
    assert.equal(renderToolLibraryDomainIndexPrompt(root, { skillIds: ['zzz'], mcpServerIds: ['other'] }), null);

    // Without visibility the curated index is unchanged.
    const curated = renderToolLibraryDomainIndexPrompt(root);
    assert.ok(curated);
    assert.match(curated, /分析|临床|空转/);
  });
});

test('readDomainIndex is the single reconciliation rule for the L1 view', async () => {
  await withLibrary({
    'index.md': '- 分析：分析领域\n- 分析：重复\n- 幽灵：不存在\n',
    '分析/index.md': '- 甲（skill：a）：一\n',
    '额外/index.md': '- 乙（skill：b）：二\n',
  }, async (root) => {
    const warnings: string[] = [];
    assert.deepEqual(readDomainIndex(root, warnings), [
      { name: '分析', description: '分析领域' },
      { name: '额外', description: '' },
    ]);
    assert.ok(warnings.some((warning) => warning.startsWith('duplicate_index_domain:')));
    assert.ok(warnings.some((warning) => warning.startsWith('unknown_domain:')));
    assert.ok(warnings.some((warning) => warning.startsWith('unlisted_domain:')));
  });
});

test('catalog sorts entries, paginates and reports has_more', async () => {
  await withLibrary({
    'index.md': '- 分析：分析领域\n',
    '分析/index.md': ['# 分析', '', '- Echo（skill：e）：五', '- Alpha（skill：a）：一', '- Charlie（skill：c）：三', '- Bravo（skill：b）：二', '- Delta（skill：d）：四', ''].join('\n'),
  }, async (root) => {
    const ctx = context(root, { skills: ['a', 'b', 'c', 'd', 'e'].map((id) => skill(id)) });
    const page = executeToolLibraryBrowse({ domain: '分析', offset: 1, limit: 2 }, ctx);

    assert.equal(page.ok, true);
    assert.equal(page.action, 'catalog');
    assert.equal(page.total, 5);
    assert.equal(page.offset, 1);
    assert.equal(page.limit, 2);
    assert.equal(page.has_more, true);
    assert.deepEqual((page.entries as any[]).map((entry) => entry.id), ['b', 'c']);
    assert.deepEqual((page.entries as any[])[0], { name: 'Bravo', kind: 'skill', id: 'b', description: '二' });
  });
});

test('catalog pages stop at the 30k character budget even below the limit', async () => {
  const entries = Array.from({ length: 80 }, (_, index) => {
    const name = `工具${String(index).padStart(3, '0')}`;
    const id = `tool-${String(index).padStart(3, '0')}`;
    return `- ${name}（skill：${id}）：${'描'.repeat(600)}`;
  }).join('\n');
  await withLibrary({
    'index.md': '- 大：大领域\n',
    '大/index.md': `${entries}\n`,
  }, async (root) => {
    const skills = Array.from({ length: 80 }, (_, index) => skill(`tool-${String(index).padStart(3, '0')}`, `工具${String(index).padStart(3, '0')}`));
    const page = executeToolLibraryBrowse({ domain: '大' }, context(root, { skills }));

    assert.equal(page.ok, true);
    assert.equal(page.total, 80);
    const rows = page.entries as any[];
    assert.ok(rows.length > 0 && rows.length < 80, `expected a partial page, got ${rows.length}`);
    assert.ok(JSON.stringify(rows).length <= TOOLLIBRARY_CATALOG_CHAR_BUDGET + 2000);
    assert.equal(page.has_more, true);
  });
});

test('catalog reports malformed and duplicate entries without failing', async () => {
  await withLibrary({
    'index.md': '- 分析：分析领域\n',
    '分析/index.md': [
      '# 分析', '',
      '- 甲（skill：a）：第一个',
      '- 乙（skill：a）：重复 id',
      '- 甲（skill：b）：重复 name',
      '- 坏行没有括号',
      `- 长（skill：c）：${'x'.repeat(701)}`,
      '',
    ].join('\n'),
  }, async (root) => {
    const ctx = context(root, { skills: ['a', 'b', 'c'].map((id) => skill(id)) });
    const page = executeToolLibraryBrowse({ domain: '分析' }, ctx);
    const warnings = page.warnings as string[];

    assert.equal(page.ok, true);
    assert.equal(page.total, 3);
    assert.ok(warnings.some((warning) => warning.startsWith('malformed_entry:')));
    assert.ok(warnings.some((warning) => warning.startsWith('duplicate_entry_id:')));
    assert.ok(warnings.some((warning) => warning.startsWith('duplicate_entry_name:')));
    assert.ok(warnings.some((warning) => warning.startsWith('description_exceeds_budget:')));
  });
});

test('entries for capabilities that are not bound are hidden with a warning', async () => {
  await withLibrary({
    'index.md': '- 分析：分析领域\n',
    '分析/index.md': '- 甲（skill：a）：可见\n- 乙（skill：hidden）：不可见\n- 丙（mcp：bio_search）：不可见工具\n',
  }, async (root) => {
    const page = executeToolLibraryBrowse({ domain: '分析' }, context(root, {
      skills: [skill('a', '甲')],
    }));

    assert.equal(page.total, 1);
    assert.equal((page.entries as any[])[0].id, 'a');
    const warnings = page.warnings as string[];
    assert.ok(warnings.some((warning) => warning.includes("'hidden'")));
    assert.ok(warnings.some((warning) => warning.includes("'bio_search'")));
  });
});

test('a domain without index.md stays reachable as an empty catalog', async () => {
  await withLibrary({
    'index.md': '- 空领域：没有文件\n',
    '空领域/notes.txt': 'not an index',
  }, async (root) => {
    const state = buildCatalogState(context(root));
    assert.equal(state.domains.length, 1);
    assert.ok(state.warnings.some((warning) => warning.startsWith('missing_domain_index:')));

    const page = executeToolLibraryBrowse({ domain: '空领域' }, context(root));
    assert.equal(page.ok, true);
    assert.equal(page.total, 0);
    assert.deepEqual(page.entries, []);
  });
});

test('unknown domains fail with guidance back to the index', async () => {
  await withLibrary({ 'index.md': '- 分析：分析领域\n' }, async (root) => {
    const result = executeToolLibraryBrowse({ domain: '不存在' }, context(root));
    assert.equal(result.ok, false);
    assert.match(String(result.error), /Unknown tool-library domain '不存在'/);
    assert.match(String(result.error), /<tool_library_domains>/);
  });
});

test('a missing library root throws instead of returning an empty catalog', async () => {
  const missing = path.join(os.tmpdir(), `bioflow-missing-library-${process.pid}`);
  assert.throws(() => executeToolLibraryBrowse({}, context(missing)), /Tool library root not found/);
});

test('toolload resolves skills by exact id, exact name and unique partial name', async () => {
  const ctx = context('/unused', {
    skills: [skill('bio-seq', 'bio-seq', 'Sequence tools.'), skill('bio-peak', 'bio-peak', 'Peak tools.')],
    tools: new Map([['bio_search', mcpTool('bio_search', 'Search.')]]),
  });

  assert.equal(executeToolLoad({ id: 'bio-seq' }, ctx).result.ok, true);
  assert.equal((executeToolLoad({ id: 'bio-seq' }, ctx).result as any).action, 'skill');
  assert.equal((executeToolLoad({ id: 'bio-seq' }, ctx).result as any).skillId, 'bio-seq');
  assert.match(String((executeToolLoad({ id: 'bio-peak' }, ctx).result as any).content), /Peak tools/);
  // Unique partial match on the display name.
  assert.equal((executeToolLoad({ id: 'seq' }, ctx).result as any).skillId, 'bio-seq');
});

test('toolload resolves MCP tools by public name or by a unique raw suffix', async () => {
  const tools = new Map([
    ['tavily_tavily_search', mcpTool('tavily_tavily_search')],
    ['exa_web_search_exa', mcpTool('exa_web_search_exa')],
  ]);
  const ctx: ToolLibraryContext = { root: '/unused', skills: [], mcpServers: [], mcpTools: tools };

  const direct = executeToolLoad({ id: 'tavily_tavily_search' }, ctx);
  assert.equal(direct.result.ok, true);
  assert.equal((direct.result as any).action, 'mcp_tool');
  assert.ok(direct.mcpTool);

  const suffix = executeToolLoad({ id: 'web_search_exa' }, ctx);
  assert.equal((suffix.result as any).id, 'exa_web_search_exa');
  assert.ok(suffix.mcpTool);
});

test('toolload rejects an ambiguous raw MCP tool name', async () => {
  const tools = new Map([
    ['one_search', mcpTool('one_search')],
    ['two_search', mcpTool('two_search')],
  ]);
  const ctx: ToolLibraryContext = { root: '/unused', skills: [], mcpServers: [], mcpTools: tools };

  const outcome = executeToolLoad({ id: 'search' }, ctx);
  assert.equal(outcome.result.ok, false);
  assert.match(String(outcome.result.error), /ambiguous/);
  assert.equal(outcome.mcpTool, undefined);
});

test('toolload rejects an id that matches nothing', async () => {
  const ctx: ToolLibraryContext = { root: '/unused', skills: [], mcpServers: [], mcpTools: new Map() };
  const outcome = executeToolLoad({ id: 'nothing' }, ctx);
  assert.equal(outcome.result.ok, false);
  assert.match(String(outcome.result.error), /is not available to this agent/);
});

test('toolload requires an id', () => {
  const ctx: ToolLibraryContext = { root: '/unused', skills: [], mcpServers: [], mcpTools: new Map() };
  const outcome = executeToolLoad({}, ctx);
  assert.equal(outcome.result.ok, false);
  assert.match(String(outcome.result.error), /requires id/);
});

test('warnings are capped at twenty entries plus a remainder', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => `- 行${index}`).join('\n');
  await withLibrary({ 'index.md': '- 分析：分析领域\n', '分析/index.md': `${rows}\n` }, async (root) => {
    const page = executeToolLibraryBrowse({ domain: '分析' }, context(root));
    const warnings = page.warnings as string[];
    assert.equal(warnings.length, 21);
    assert.equal(warnings[20], '5 more warnings omitted.');
  });
});

test('skill loads inline body resources within a shared budget and list the rest', () => {
  const resources = Array.from({ length: 5 }, (_, index) => ({
    id: `resource-${index}`,
    fileName: `ref-${index}.md`,
    mimeType: 'text/markdown',
    size: 4000,
    content: 'r'.repeat(4000),
    encoding: 'utf8' as const,
  }));
  const ctx = context('/unused', {
    skills: [{ id: 'long-skill', name: 'long-skill', description: 'Long skill.', instructions: 'Body.', resources }],
  });
  const outcome = executeToolLoad({ id: 'long-skill' }, ctx);
  const content = String((outcome.result as any).content);

  assert.equal(SKILL_RESOURCE_INLINE_BUDGET, 8000);
  assert.equal(content.match(/### Resource:/g)?.length, 2);
  assert.match(content, /resource content budget exhausted/);
  assert.match(content, /ref-2\.md/);
});
