// highlight.js 实例：只用 core 入口 + 显式注册语言，避免全量打包。
// 新增语言前先看构建产物体积（B 批验收要求 gzip 增量 < 120KB）。
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = { bash, c, cpp, diff, javascript, json, markdown, python, r, rust, typescript, yaml };

for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES);

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 返回已转义的 HTML 片段。语言未注册或高亮抛错时回退为纯转义文本，
 * 因此调用方可以放心把它交给 dangerouslySetInnerHTML。
 */
export function highlightToHtml(code, language) {
  const text = String(code ?? '');
  if (!language || !hljs.getLanguage(language)) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}
