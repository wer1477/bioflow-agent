// 对比度纪律：深色不是「把浅色调暗」，而是要在 WCAG 阈值上可测量。
// 本测试只做静态断言：解析令牌 → 计算对比度 → 约束关键配对；
// 另外两条纪律挡住「字面量浅色渐变」和「反色实心」——它们是深色下文字看不清的根因。
// 纯 Node、无浏览器依赖，解析器在 css_tokens.mjs 里与 styles_scope.test.mjs 共享。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contrastRatio, loadStylesheet, readThemeTokens, resolveToken, stripComments, withoutTokenBlocks,
} from './css_tokens.mjs';

const css = stripComments(loadStylesheet());
const { light: LIGHT, dark: DARK } = readThemeTokens(css);

// [前景, 背景, 阈值]。正文/按钮/状态文字按 AA 4.5；--muted-soft 是元信息，按 3.0。
const PAIRS = [
  ['--text', '--bg', 4.5],
  ['--text', '--panel', 4.5],
  ['--text', '--soft', 4.5],
  ['--text-soft', '--panel', 4.5],
  ['--muted', '--panel', 4.5],
  ['--muted', '--bg', 4.5],
  ['--muted-soft', '--panel', 3.0],
  ['--accent', '--panel', 4.5],
  ['--danger', '--panel', 4.5],
  ['--on-accent', '--accent', 4.5],
  ['--success-text', '--success-bg', 4.5],
  ['--warning-text', '--warning-bg', 4.5],
  ['--danger-text', '--danger-bg', 4.5],
  ['--tip-fg', '--tip-bg', 4.5],
  ['--ink', '--panel', 4.5],
];

// 代码面板（.code-block / .diff-lines / .terminal-command）的底色在明暗两态都是深色，
// 所以这些前景色要在两张令牌表上都对 --code-surface / --code-bg 达标。
PAIRS.push(
  ['--code-text', '--code-surface', 4.5],
  ['--code-text', '--code-bg', 4.5],
  ['--code-muted', '--code-surface', 4.5],
  ['--code-muted', '--code-bg', 4.5],
);

// 语法色只承担"区分 token"，按 3:1 的地板；它们同样不随主题切换。
const SYNTAX_FOREGROUNDS = [
  '--syntax-comment', '--syntax-keyword', '--syntax-string', '--syntax-number',
  '--syntax-function', '--syntax-attr', '--syntax-type', '--syntax-deletion',
  '--diff-add-fg', '--diff-del-fg', '--diff-add-sign', '--diff-del-sign',
];
for (const token of SYNTAX_FOREGROUNDS) PAIRS.push([token, '--code-surface', 3.0]);

for (const [theme, map] of [['light', LIGHT], ['dark', DARK]]) {
  test(`${theme} 主题：关键文字配对比度达标`, () => {
    for (const [fg, bg, min] of PAIRS) {
      const ratio = contrastRatio(resolveToken(map, fg), resolveToken(map, bg));
      assert.ok(
        ratio >= min,
        `${theme}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1，低于 ${min.toFixed(1)}:1`,
      );
    }
  });
}

/** 去掉两个令牌块后的「规则体」——纪律只约束规则体，令牌定义里允许字面颜色。 */
const ruleBody = withoutTokenBlocks(css);

test('规则体内不使用字面量渐变终点（浅色渐变在深色下会变成白雾）', () => {
  const offenders = [];
  for (const match of ruleBody.matchAll(/background(?:-image)?\s*:\s*([^;]+);/g)) {
    const value = match[1];
    if (!value.includes('gradient(')) continue;
    // 只拦「写死的颜色」：rgb(245,251,248) / #fff 这种；rgba(var(--x), a) 是随主题走的，放行。
    if (/(?:rgba?|hsla?)\(\s*[\d.]/.test(value) || /#[0-9a-f]{3,8}\b/i.test(value)) offenders.push(value.trim());
  }
  assert.deepEqual(offenders, [], `存在字面量渐变：${offenders.join(' | ')}`);
});

test('不再用 --ink 反向填充（深色下会翻成浅色实心块）', () => {
  const offenders = [...ruleBody.matchAll(/background(?:-color)?\s*:\s*var\(--ink\)/g)].map((match) => match[0]);
  assert.deepEqual(offenders, [], `存在反色实心：${offenders.join(' | ')}`);
});
