import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function isSafeHref(href) {
  return typeof href === 'string' && /^(https?:|mailto:)/i.test(href);
}

function MarkdownLink({ node, href, children, ...props }) {
  if (!isSafeHref(href)) return createElement('span', null, children);
  return createElement('a', { ...props, href, target: '_blank', rel: 'noreferrer' }, children);
}

function MarkdownTable({ node, children, ...props }) {
  return createElement('div', { className: 'markdown-table-scroll' }, createElement('table', props, children));
}

/**
 * 纯 markdown 渲染：只做链接白名单与表格包裹，**不依赖任何 .jsx 模块**。
 * web/test 下的测试由 `node --test` 直接执行，无法加载 .jsx；
 * 需要代码块的调用方通过 `pre` 注入渲染器（见 components/chat/Markdown.jsx），
 * 需要"行内代码里的路径可点"则通过 `code` 注入。
 */
export function AssistantMarkdown({ content, pre, code }) {
  return createElement('div', { className: 'assistant-markdown' }, createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    components: {
      a: MarkdownLink,
      table: MarkdownTable,
      ...(pre ? { pre } : {}),
      ...(code ? { code } : {}),
    },
  }, content || ''));
}
