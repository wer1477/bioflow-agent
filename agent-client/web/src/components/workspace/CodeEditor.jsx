import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { highlightToHtml } from '../../highlight.js';

/** 超过这个行数就只渲染纯文本：highlight.js 每次按键都跑一遍会拖慢输入。 */
const HIGHLIGHT_MAX_LINES = 2000;
const INDENT = '  ';

/**
 * 无依赖代码编辑器：一个透明文字的 textarea 叠在高亮层之上。
 * 两层共用字体/行高/内边距，因此光标、选区与高亮逐字对齐；滚动由 textarea 驱动，
 * 高亮层与行号列只做 translate，不触发 React 重渲染。
 */
export const CodeEditor = memo(function CodeEditor({
  value = '', language = '', wrap = false, onChange, onSave, ariaLabel = '文件内容',
}) {
  const textareaRef = useRef(null);
  const highlightRef = useRef(null);
  const gutterRef = useRef(null);
  const text = String(value ?? '');
  const lines = useMemo(() => text.split('\n'), [text]);
  const highlighted = lines.length <= HIGHLIGHT_MAX_LINES;
  const html = useMemo(
    () => (highlighted ? highlightToHtml(text, language) : ''),
    [highlighted, language, text],
  );

  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { scrollTop, scrollLeft } = textarea;
    if (highlightRef.current) {
      highlightRef.current.style.transform = wrap ? `translateY(${-scrollTop}px)` : `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    }
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-scrollTop}px)`;
  }, [wrap]);

  // 换文件、换换行模式后把滚动位置归零，避免两层错位。
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.scrollTop = 0;
    textarea.scrollLeft = 0;
    syncScroll();
  }, [language, wrap, syncScroll]);

  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const textarea = event.currentTarget;
      const { selectionStart, selectionEnd } = textarea;
      const next = `${text.slice(0, selectionStart)}${INDENT}${text.slice(selectionEnd)}`;
      onChange?.(next);
      requestAnimationFrame(() => {
        textarea.selectionStart = selectionStart + INDENT.length;
        textarea.selectionEnd = selectionStart + INDENT.length;
      });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave?.();
    }
  }, [onChange, onSave, text]);

  return (
    <div className={`code-editor${wrap ? ' is-wrapped' : ''}`}>
      <div className="code-editor-gutter" ref={gutterRef} aria-hidden="true">
        {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
      </div>
      <div className="code-editor-highlight" ref={highlightRef} aria-hidden="true">
        {highlighted
          ? <pre><code dangerouslySetInnerHTML={{ __html: `${html}\n` }} /></pre>
          : <pre><code>{text}</code></pre>}
      </div>
      <textarea
        ref={textareaRef}
        className="code-editor-input"
        value={text}
        spellCheck="false"
        autoCapitalize="off"
        autoCorrect="off"
        wrap={wrap ? 'soft' : 'off'}
        aria-label={ariaLabel}
        onChange={(event) => onChange?.(event.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
});
