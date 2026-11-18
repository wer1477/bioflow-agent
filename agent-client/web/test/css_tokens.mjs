// 共享的样式解析与对比度工具。
//
// contrast.test.mjs 与 styles_scope.test.mjs 都从这里取，避免两套解析器对同一份 CSS
// 得出不同结论。纯 Node、无浏览器依赖，和其它 web 测试同构。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ENTRY = new URL('../styles.css', import.meta.url);

/** styles.css 只是 @import 清单；按声明顺序读入，拼成等价的一份 CSS。 */
export function loadStylesheet() {
  const entry = readFileSync(ENTRY, 'utf8');
  const imports = [...entry.matchAll(/@import\s+'([^']+)'/g)].map((match) => match[1]);
  if (!imports.length) return entry;
  return imports.map((rel) => readFileSync(new URL(rel, ENTRY), 'utf8')).join('\n');
}

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取某个选择器后面的简单块（令牌块里没有嵌套花括号，够用）。 */
export function blockBody(css, selector) {
  const match = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `找不到令牌块 ${selector}`);
  return match[1];
}

/** 把块里的 `--name: value;` 收成 Map。 */
export function collectTokens(body) {
  const map = new Map();
  for (const match of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) map.set(match[1], match[2].trim());
  return map;
}

/** 一层层展开 var()，直到拿到字面颜色。 */
export function resolveToken(map, name, depth = 4) {
  let value = map.get(name);
  assert.ok(value !== undefined, `未定义令牌 ${name}`);
  while (depth-- > 0 && value.includes('var(')) {
    value = value.replace(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g, (_, ref) => {
      const next = map.get(ref);
      assert.ok(next !== undefined, `令牌 ${name} 引用了未定义的 ${ref}`);
      return next;
    });
  }
  return value;
}

/** 明暗两态的令牌表。深色表按 CSS 层叠语义合并明色表：`:root` 在深色下依然生效，
    `[data-theme="dark"]` 只覆盖它声明的那部分（--syntax-* 这类就是"两态同一套"）。 */
export function readThemeTokens(css = stripComments(loadStylesheet())) {
  const light = collectTokens(blockBody(css, ':root'));
  const dark = new Map([...light, ...collectTokens(blockBody(css, '\\[data-theme="dark"\\]'))]);
  return { light, dark };
}

/** 去掉两个令牌块后的「规则体」——纪律只约束规则体，令牌定义里允许字面颜色。 */
export function withoutTokenBlocks(css) {
  return css
    .replace(/:root\s*\{[\s\S]*?\n\}/, '')
    .replace(/\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/, '');
}

function matchBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** `a: b; c: d` → [{ prop, value }]，按第一个冒号切分。 */
function parseDeclarations(body) {
  const declarations = [];
  for (const chunk of body.split(';')) {
    const text = chunk.trim();
    if (!text) continue;
    const colon = text.indexOf(':');
    if (colon <= 0) continue;
    declarations.push({ prop: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() });
  }
  return declarations;
}

/**
 * 把 CSS 拆成叶子规则。`@media` / `@supports` 这类容器块会展开，
 * 并把容器自己的条件作为 `contexts` 带给里面的规则。
 */
export function parseRules(css) {
  const rules = [];
  const visit = (text, contexts) => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf('{', index);
      if (open === -1) return;
      const close = matchBrace(text, open);
      if (close === -1) return;
      const selector = text.slice(index, open).replace(/\s+/g, ' ').trim();
      const body = text.slice(open + 1, close);
      if (selector.startsWith('@')) visit(body, [selector, ...contexts]);
      else rules.push({ selector, contexts, declarations: parseDeclarations(body) });
      index = close + 1;
    }
  };
  visit(css, []);
  return rules;
}

export function parseColor(text) {
  const value = String(text).trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return { r: parseInt(raw.slice(0, 2), 16), g: parseInt(raw.slice(2, 4), 16), b: parseInt(raw.slice(4, 6), 16) };
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2] };
  }
  throw new Error(`不认识的颜色值：${text}`);
}

export function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(fg, bg) {
  const a = relativeLuminance(parseColor(fg));
  const b = relativeLuminance(parseColor(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
