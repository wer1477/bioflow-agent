// 尺度令牌纪律测试：拆分后的样式必须走令牌，且引用的令牌必须已定义。
// 纯 Node，无依赖——和其余 web 测试一样只做静态断言，不引入浏览器环境。

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const ENTRY = new URL('../styles.css', import.meta.url);

/** styles.css 现在只是 @import 清单；按声明顺序读入，拼成等价的一份 CSS。 */
function loadStylesheet() {
  const entry = readFileSync(ENTRY, 'utf8');
  const imports = [...entry.matchAll(/@import\s+'([^']+)'/g)].map((match) => match[1]);
  if (!imports.length) return entry;
  return imports.map((rel) => readFileSync(new URL(rel, ENTRY), 'utf8')).join('\n');
}

const css = loadStylesheet();

/** 去掉注释，避免把注释里的示例值当成真实声明。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const source = stripComments(css);

/** 收集所有 `prop: value;` 声明（排除自定义属性定义）。 */
function declarations(prop) {
  const pattern = new RegExp(`(?<![\\w-])${prop}\\s*:\\s*([^;{}]+);`, 'g');
  return [...source.matchAll(pattern)].map((match) => match[1].trim());
}

/** 收集所有已定义的自定义属性名。 */
const definedTokens = new Set([...source.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));

/** 收集所有被 var() 引用的自定义属性名。 */
const usedTokens = new Set([...source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));

// 由 JSX 内联 style 注入的令牌：它们不会出现在 styles.css 里，
// 但确实是运行时定义的。改动这些注入点时要同步这份清单。
//   --entry-delay                  src/components/settings/ToolLibrarySettings.jsx
//   --dock-width                   src/components/workspace/RightDock.jsx
//                                  （走变量而非内联 width，窄屏断点才能不用 !important 收敛）
const RUNTIME_TOKENS = new Set(['--entry-delay', '--dock-width']);

// 尺度属性只允许写 var(...)。白名单是「本来就不该是尺度值」的合法裸值。
const ALLOWED = {
  'border-radius': [/^0$/, /^inherit$/, /^50%$/],
  'font-size': [/em$/],           // 相对字号（如 0.9em 的行内 code）
  'line-height': [/^20px$/],      // 固定行高的代码预览行，绝对行高才是正确语义
  'box-shadow': [/^none$/],
  'z-index': [],
};

for (const [prop, allowed] of Object.entries(ALLOWED)) {
  test(`${prop} 在规则体内只使用令牌`, () => {
    const offenders = declarations(prop).filter(
      (value) => !value.includes('var(') && !allowed.some((pattern) => pattern.test(value)),
    );
    assert.deepEqual(offenders, [], `${prop} 存在未令牌化的裸值：${offenders.join(' | ')}`);
  });
}

test('所有 var() 引用的令牌都已定义', () => {
  const undefinedTokens = [...usedTokens]
    .filter((name) => !definedTokens.has(name) && !RUNTIME_TOKENS.has(name))
    .sort();
  assert.deepEqual(undefinedTokens, [], `引用了未定义的令牌：${undefinedTokens.join(', ')}`);
});

test('旧的 --shadow-* 令牌已完全被尺度令牌取代', () => {
  for (const legacy of ['--shadow-sm', '--shadow-md', '--shadow-lg']) {
    assert.ok(!definedTokens.has(legacy), `${legacy} 仍有定义`);
    assert.ok(!usedTokens.has(legacy), `${legacy} 仍被引用`);
  }
});

const SCALE_TOKENS = [
  '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-pill',
  '--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-base', '--text-lg', '--text-xl', '--text-2xl',
  '--leading-none', '--leading-tight', '--leading-snug', '--leading-normal', '--leading-relaxed',
  '--shadow-lv1', '--shadow-lv2', '--shadow-lv3', '--shadow-accent',
  '--ring-accent', '--ring-focus', '--ring-info',
  '--duration-fast', '--duration-base', '--duration-slow', '--ease-standard',
  '--z-base', '--z-raised', '--z-sticky', '--z-dropdown', '--z-backdrop', '--z-toast',
];

test('尺度令牌齐备', () => {
  const missing = SCALE_TOKENS.filter((name) => !definedTokens.has(name));
  assert.deepEqual(missing, [], `缺少尺度令牌：${missing.join(', ')}`);
});

// A 批为「字形当图标」临时引入的 --icon-* 已在 C 批随 SVG 图标落地而删除。
test('临时的图标字形令牌已退役', () => {
  for (const legacy of ['--icon-sm', '--icon-md', '--icon-lg']) {
    assert.ok(!definedTokens.has(legacy), `${legacy} 应已删除`);
    assert.ok(!usedTokens.has(legacy), `${legacy} 仍被引用`);
  }
});

// 尺度令牌是「组件可消费的契约」，不是装饰：声明了就必须有消费者，
// 否则就是死代码（A 批已按此原则把未消费的间距尺度移出）。
test('每个尺度令牌都有消费者', () => {
  const orphaned = SCALE_TOKENS.filter((name) => !usedTokens.has(name));
  assert.deepEqual(orphaned, [], `声明但无人引用的尺度令牌：${orphaned.join(', ')}`);
});

test('暗色主题覆盖阴影尺度（暗色需要更高的不透明度）', () => {
  const darkBlock = source.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(darkBlock, '找不到 [data-theme="dark"] 块');
  for (const name of ['--shadow-lv1', '--shadow-lv2', '--shadow-lv3']) {
    assert.match(darkBlock[1], new RegExp(`${name}\\s*:`), `暗色未覆盖 ${name}`);
  }
});
