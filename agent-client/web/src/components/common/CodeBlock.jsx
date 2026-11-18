import { memo, useMemo, useState } from 'react';
import { copyToClipboard } from '../../clipboard.js';
import { highlightToHtml } from '../../highlight.js';
import { CheckIcon, CopyIcon } from './icons.jsx';

/**
 * 代码块：语言标签 + 行号 + 复制。
 * 复制的是**原始代码**（完整文本），不是截断后用于展示的部分。
 *
 * 行号用独立 gutter 渲染，而不是把高亮结果按行切开——highlight.js 的输出
 * 可能包含跨行 token（块注释、多行字符串），按行切会破坏高亮。
 *
 * 调用方可以关掉 header / 复制按钮：文件预览面板的工具栏已经提供了复制，
 * 同一个功能出现两遍只会让人犹豫该点哪个。
 */
export const CodeBlock = memo(function CodeBlock({
  code, language = '', label = '', showLineNumbers = true, maxLines = 0,
  wrap = false, showHeader = true, showCopy = true,
}) {
  const [copied, setCopied] = useState(false);

  const text = String(code ?? '');
  const lines = useMemo(() => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n'), [text]);
  const truncated = maxLines > 0 && lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines) : lines;
  const html = useMemo(() => highlightToHtml(shown.join('\n'), language), [shown, language]);

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block">
      {showHeader && (
        <div className="code-block-header">
          <span className="code-block-language">{language || 'text'}</span>
          {label && <span className="code-block-label" data-tooltip={label}>{label}</span>}
          {showCopy && (
            <button
              className="code-block-copy"
              type="button"
              onClick={handleCopy}
              aria-label={copied ? '已复制' : '复制代码'}
              data-tooltip={copied ? '已复制' : '复制代码'}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
        </div>
      )}
      <pre className={`code-block-body${wrap ? ' is-wrapped' : ''}`}>
        {showLineNumbers && (
          <span className="code-gutter" aria-hidden="true">
            {shown.map((_, index) => index + 1).join('\n')}
          </span>
        )}
        <code className="code-content" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {truncated && <div className="code-block-footer">仅显示前 {maxLines} 行，共 {lines.length} 行</div>}
    </div>
  );
});
