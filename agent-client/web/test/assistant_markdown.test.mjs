import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantMarkdown } from '../src/assistant_markdown.js';

test('renders assistant Markdown as readable, safe HTML', () => {
  const html = renderToStaticMarkup(createElement(AssistantMarkdown, {
    content: '# 生物信息学助手\n\n**文献检索**\n\n- PubMed\n- Europe PMC\n\n`BLAST`\n\n[不安全链接](javascript:alert("unsafe"))\n\n<script>alert("unsafe")</script>',
  }));

  assert.match(html, /<h1>生物信息学助手<\/h1>/);
  assert.match(html, /<strong>文献检索<\/strong>/);
  assert.match(html, /<li>PubMed<\/li>/);
  assert.match(html, /<code>BLAST<\/code>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /\*\*文献检索\*\*/);
});

test('a caller-supplied pre renderer replaces the default code block', () => {
  // 代码块渲染需要 .jsx（CodeBlock），而本测试由 node --test 直接执行，
  // 因此 assistant_markdown.js 只提供注入点，由 components/chat/Markdown.jsx 挂上实现。
  const html = renderToStaticMarkup(createElement(AssistantMarkdown, {
    content: '```python\nprint(1)\n```',
    pre: ({ children }) => createElement('div', { className: 'custom-pre' }, children),
  }));

  assert.match(html, /class="custom-pre"/);
  assert.doesNotMatch(html, /<pre>/);
});
