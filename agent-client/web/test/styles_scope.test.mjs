// 样式作用域纪律：配色令牌必须用在配套的底色上。
//
// 真实的坑：`.workspace-code-preview code { color: var(--text) }` 本来是给"随主题走的
// <ol> 预览"写的，却把 CodeBlock 里深色底上的 `<code>` 也命中，明色主题下拿到近黑的
// --text，和 #0f172a 的对比度只有 1.09:1——"有些代码字看不清"就是这么来的。
//
// contrast.test.mjs 只能证明"令牌两两配对达标"，证明不了"令牌用对了地方"。
// 这个文件补上那一层：代码面板里只允许代码令牌，主题文字色用在 code/pre 上必须登记。

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStylesheet, parseRules, stripComments } from './css_tokens.mjs';

const css = stripComments(loadStylesheet());
const rules = parseRules(css);

/**
 * 「代码面板」：底色是 --code-surface / --code-bg 这类与主题无关的深色的作用域。
 * 注意不含 `.code-editor*`——编辑器的底色是随主题走的 --surface-tint，不属于深色面板。
 */
const CODE_SCOPES = [
  '.code-block', '.code-block-body', '.code-block-header', '.code-block-footer',
  '.code-content', '.code-gutter', '.code-block-language', '.code-block-label', '.code-block-copy',
  '.diff-lines', '.diff-line', '.diff-add', '.diff-del', '.diff-hunk', '.diff-meta', '.diff-ctx',
  '.terminal-command', '.terminal-body', '.terminal-prompt',
];

/** 某个选择器的某一段是否正好落在某个作用域（`.code-block-x` 不算 `.code-block`）。 */
function partInScope(part, scope) {
  const text = part.trim();
  return text === scope
    || text.startsWith(`${scope} `)
    || text.startsWith(`${scope}>`)
    || text.startsWith(`${scope}.`)
    || text.startsWith(`${scope}:`)
    || text.startsWith(`${scope}[`);
}

function inCodeScope(selector) {
  return CODE_SCOPES.some((scope) => selector.split(',').some((part) => partInScope(part, scope)));
}

const CODE_FOREGROUND = /^var\(--(?:code|syntax|diff)-[a-z0-9-]+\)$/;

test('代码面板内的文字颜色只来自代码令牌', () => {
  const offenders = [];
  for (const rule of rules) {
    if (!inCodeScope(rule.selector)) continue;
    for (const { prop, value } of rule.declarations) {
      if (prop !== 'color') continue;
      // inherit 是显式放行：它只是把颜色交还给父级（代码面板的父级已经是对的）。
      if (value === 'inherit' || CODE_FOREGROUND.test(value)) continue;
      offenders.push(`${rule.selector} { color: ${value} }`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `代码面板是深色底，里面只能用 --code-* / --syntax-* / --diff-*：\n${offenders.join('\n')}`,
  );
});

/** 随主题翻转的文字色：压在深色代码面板上就会失配。 */
const THEME_FOREGROUNDS = new Set([
  '--text', '--text-soft', '--muted', '--muted-soft', '--ink',
  '--accent', '--accent-strong', '--info', '--danger',
  '--success-text', '--warning-text', '--danger-text',
]);

/**
 * 允许用"随主题走"的文字色给 code/pre 上色的选择器。
 * 判据：这些规则的底色同样随主题走（--surface-tint / --panel / --danger-bg），配对比度成立。
 * 新增条目必须写明底色——底色不随主题走却用主题文字色，就是这次的 bug。
 */
const THEME_COLORED_CODE_SELECTORS = new Set([
  '.assistant-markdown :not(pre) > code', // 行内代码，底色 --surface-tint
  '.assistant-markdown .tool-path-link.is-inline code', // 透明底，继承正文
  '.workspace-code-preview ol code', // 无高亮行号预览，底色 --surface-tint
  '.workspace-record-head code', // 底色 --panel
  '.workspace-record pre', // 底色 --panel
  '.workspace-record pre.workspace-quality', // 底色 --panel
  '.goal-dock-blocked-detail code', // 底色 --danger-bg
  '.kb-resources code', // 底色 --surface-tint
  '.search-match-preview, .search-match.path code', // 底色 --surface-hover / 继承
  '.code-editor-highlight pre', // 编辑器高亮层，底色 --surface-tint（编辑器不是深色面板）
]);

test('给 code/pre 上主题文字色的规则必须显式登记', () => {
  const offenders = [];
  for (const rule of rules) {
    const targetsCode = rule.selector
      .split(',')
      .some((part) => /(^|[\s>+~])(code|pre)\b/.test(part.trim()));
    if (!targetsCode) continue;
    for (const { prop, value } of rule.declarations) {
      if (prop !== 'color') continue;
      const token = value.match(/^var\((--[a-z0-9-]+)\)$/)?.[1];
      if (!token || !THEME_FOREGROUNDS.has(token)) continue;
      // 规则体的选择器可能被拆成多行，按整串登记。
      if (THEME_COLORED_CODE_SELECTORS.has(rule.selector)) continue;
      offenders.push(`${rule.selector} { color: ${value} }`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些规则用随主题翻转的文字色给 code/pre 上色。若它的底色也随主题走，'
    + `请登记到 THEME_COLORED_CODE_SELECTORS 并注明底色；否则改用代码令牌：\n${offenders.join('\n')}`,
  );
});
