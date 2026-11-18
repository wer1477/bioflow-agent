import { createElement, useMemo } from 'react';
import { AssistantMarkdown } from '../../assistant_markdown.js';
import { CodeBlock } from '../common/CodeBlock.jsx';

/**
 * 块级代码改走 CodeBlock（语言标签 + 行号 + 高亮 + 复制）。
 * react-markdown 把块级代码渲染成 <pre><code class="language-x">…</code></pre>，
 * 因此在这里取出语言与源码文本。行内代码不经过 pre，仍用默认 <code>。
 */
function MarkdownPre({ children }) {
  const child = Array.isArray(children) ? children[0] : children;
  const props = child?.props || {};
  const language = /language-([\w-]+)/.exec(props.className || '')?.[1] || '';
  return createElement(CodeBlock, { code: extractText(props.children ?? children), language });
}

function extractText(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node.props?.children) return extractText(node.props.children);
  return '';
}

/**
 * 行内代码里的项目路径：能在当前项目文件树里找到就渲染成可点按钮，
 * 找不到（或不是路径）保持原来的 <code>，不改变任何现有渲染。
 */
function InlineCode({ children, onOpenFile, resolveOpenablePath }) {
  const text = extractText(children);
  const path = resolveOpenablePath && !/\s/.test(text) ? resolveOpenablePath(text) : null;
  if (!path) return createElement('code', null, children);
  return createElement(
    'button',
    { type: 'button', className: 'tool-path-link is-inline', onClick: () => onOpenFile(path), 'data-tooltip': `打开 ${path}` },
    createElement('code', null, children),
  );
}

/** 聊天区使用的 markdown：在纯 markdown 之上挂上代码块渲染与路径链接。 */
export function Markdown({ content, onOpenFile, resolveOpenablePath }) {
  const code = useMemo(
    () => (resolveOpenablePath && onOpenFile
      ? (props) => createElement(InlineCode, { ...props, onOpenFile, resolveOpenablePath })
      : null),
    [onOpenFile, resolveOpenablePath],
  );
  return <AssistantMarkdown content={content} pre={MarkdownPre} code={code} />;
}
