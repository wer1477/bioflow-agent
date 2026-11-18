import { memo } from 'react';
import { CodeBlock } from '../../common/CodeBlock.jsx';
import { JsonTree } from '../../common/JsonTree.jsx';
import { formatBytes } from '../../../domain/tool_kind.js';

/** 卡片体分发：按 toolCardModel().card 选择渲染器。 */
export const ToolCardBody = memo(function ToolCardBody({ model, onOpenFile }) {
  if (model.error) {
    return (
      <div className="tool-card-error" role="alert">
        <strong>执行失败</strong>
        <span>{model.error}</span>
      </div>
    );
  }
  const Body = BODY_BY_CARD[model.card] || GenericBody;
  return <Body model={model} onOpenFile={onOpenFile} />;
});

/**
 * 工具结果里的项目路径：有打开入口时渲染成按钮，直接跳到「项目文件」标签里的这个文件。
 * 没有入口（例如复用工具卡的其它页面）就退化成纯文本，行为不变。
 */
const FilePathLink = memo(function FilePathLink({ path, onOpenFile, label }) {
  const value = String(path || '');
  if (!value) return null;
  if (!onOpenFile) return <span className="tool-body-meta">{value}</span>;
  return (
    <button className="tool-path-link" type="button" data-tooltip={`打开 ${value}`} onClick={() => onOpenFile(value)}>
      {label || value}
    </button>
  );
});

const TerminalBody = memo(function TerminalBody({ model }) {
  const { command, cwd, stdout, stderr, exitCode, timedOut, truncated } = model.body;
  return (
    <div className="tool-body terminal-body">
      {command && (
        <div className="terminal-command">
          <span className="terminal-prompt" aria-hidden="true">$</span>
          <code>{command}</code>
        </div>
      )}
      {cwd && <div className="tool-body-meta">{cwd}</div>}
      {stdout && <CodeBlock code={stdout} language="bash" showLineNumbers={false} maxLines={400} />}
      {stderr && <CodeBlock code={stderr} language="bash" label="stderr" showLineNumbers={false} maxLines={400} />}
      <div className="tool-body-badges">
        {exitCode !== undefined && exitCode !== null && (
          <span className={`tool-badge${exitCode === 0 ? '' : ' danger'}`}>exit {exitCode}</span>
        )}
        {timedOut && <span className="tool-badge danger">超时</span>}
        {truncated && <span className="tool-badge">输出已截断</span>}
      </div>
      {!stdout && !stderr && <div className="tool-body-empty">没有输出</div>}
    </div>
  );
});

const CodeBody = memo(function CodeBody({ model }) {
  const { code, stdout, stderr, resultPreview, session, artifacts } = model.body;
  return (
    <div className="tool-body code-body">
      {code && <CodeBlock code={code} language="python" />}
      {stdout && <CodeBlock code={stdout} language="text" label="stdout" showLineNumbers={false} maxLines={400} />}
      {stderr && <CodeBlock code={stderr} language="text" label="stderr" showLineNumbers={false} maxLines={400} />}
      {!stdout && resultPreview && <CodeBlock code={resultPreview} language="text" label="result" showLineNumbers={false} />}
      <div className="tool-body-badges">
        {session && <span className="tool-badge">kernel {session}</span>}
        {artifacts.length > 0 && <span className="tool-badge">{artifacts.length} 个产物</span>}
      </div>
    </div>
  );
});

const FileBody = memo(function FileBody({ model, onOpenFile }) {
  const { action, path, content, size, returnedLines, totalLines, truncated } = model.body;
  return (
    <div className="tool-body file-body">
      {path && <FilePathLink path={path} onOpenFile={onOpenFile} />}
      {content && <CodeBlock code={content} language={model.language} maxLines={500} />}
      <div className="tool-body-badges">
        {action === 'write' && <span className="tool-badge">已写入</span>}
        {returnedLines && totalLines ? <span className="tool-badge">{returnedLines}/{totalLines} 行</span> : null}
        {size !== undefined && <span className="tool-badge">{formatBytes(size)}</span>}
        {truncated && <span className="tool-badge">已截断</span>}
      </div>
      {!content && action === 'write' && <div className="tool-body-empty">文件已写入，没有回显内容</div>}
    </div>
  );
});

const DiffBody = memo(function DiffBody({ model, onOpenFile }) {
  const body = model.body;
  if (body.kind === 'patch') {
    return (
      <div className="tool-body diff-body">
        {body.cwd && <div className="tool-body-meta">{body.cwd}</div>}
        <DiffLines lines={body.lines} />
        <FileChangeList files={body.files} onOpenFile={onOpenFile} />
      </div>
    );
  }
  const unchanged = body.context.length;
  return (
    <div className="tool-body diff-body">
      {body.path && <FilePathLink path={body.path} onOpenFile={onOpenFile} />}
      <DiffLines lines={[...body.removed, ...body.added]} />
      <div className="tool-body-badges">
        <span className="tool-badge">+{body.additions}</span>
        <span className="tool-badge">−{body.deletions}</span>
        {unchanged > 0 && <span className="tool-badge">{unchanged} 行未变</span>}
        {body.replaceAll && <span className="tool-badge">全部替换</span>}
      </div>
    </div>
  );
});

const DiffLines = memo(function DiffLines({ lines }) {
  if (!lines.length) return <div className="tool-body-empty">没有差异内容</div>;
  return (
    <div className="diff-lines">
      {lines.map((line, index) => (
        <div key={`${index}-${line.type}`} className={`diff-line diff-${line.type}`}>
          <span className="diff-sign" aria-hidden="true">{signFor(line.type)}</span>
          <code>{line.text || ' '}</code>
        </div>
      ))}
    </div>
  );
});

const FileChangeList = memo(function FileChangeList({ files, onOpenFile }) {
  if (!files.length) return null;
  return (
    <ul className="diff-file-list">
      {files.map((file) => (
        <li key={file.path}>
          <FilePathLink path={file.path} onOpenFile={onOpenFile} label={<code>{file.path}</code>} />
          <span className="tool-badge">{file.change}{file.hunks ? ` · ${file.hunks} hunk` : ''}</span>
        </li>
      ))}
    </ul>
  );
});

const SearchBody = memo(function SearchBody({ model, onOpenFile }) {
  const { mode, path, matches } = model.body;
  return (
    <div className="tool-body search-body">
      {path && <FilePathLink path={path} onOpenFile={onOpenFile} />}
      {matches.length === 0 ? (
        <div className="tool-body-empty">没有匹配结果</div>
      ) : (
        <ul className="search-matches">
          {matches.map((match, index) => (
            mode === 'glob'
              ? <li key={`${match}-${index}`} className="search-match path"><FilePathLink path={match} onOpenFile={onOpenFile} label={<code>{match}</code>} /></li>
              : (
                <li key={`${match.path}-${match.line}-${index}`} className="search-match">
                  <span className="search-match-location"><FilePathLink path={match.path} onOpenFile={onOpenFile} label={<code>{match.path}</code>} /><span className="search-match-line">{match.line}</span></span>
                  <code className="search-match-preview">{match.preview}</code>
                </li>
              )
          ))}
        </ul>
      )}
    </div>
  );
});

const WebBody = memo(function WebBody({ model }) {
  const { url, status, statusText, title, content, contentKind, truncated } = model.body;
  return (
    <div className="tool-body web-body">
      <div className="tool-body-meta">
        {url}
        {status ? <span className="tool-badge">{status}{statusText ? ` ${statusText}` : ''}</span> : null}
      </div>
      {title && <h4 className="web-title">{title}</h4>}
      {content && <pre className="web-content">{content}</pre>}
      <div className="tool-body-badges">
        {contentKind && <span className="tool-badge">{contentKind}</span>}
        {truncated && <span className="tool-badge">已截断</span>}
      </div>
      {!content && <div className="tool-body-empty">没有抓到正文</div>}
    </div>
  );
});

const PlanBody = memo(function PlanBody({ model }) {
  const steps = model.body.steps;
  if (!steps.length) return <div className="tool-body-empty">没有步骤</div>;
  return (
    <ol className="plan-steps">
      {steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
    </ol>
  );
});

const CapabilityBody = memo(function CapabilityBody({ model }) {
  const { content } = model.body;
  return (
    <div className="tool-body capability-body">
      {model.subtitle && <div className="tool-body-meta">{model.subtitle}</div>}
      {content ? <pre className="web-content">{content}</pre> : <div className="tool-body-empty">没有可展示的内容</div>}
    </div>
  );
});

const GenericBody = memo(function GenericBody({ model }) {
  const { input, output, plainText } = model.body;
  const hasInput = input && Object.keys(input).length > 0;
  return (
    <div className="tool-body generic-body">
      {hasInput && (
        <section className="tool-body-section">
          <h4>输入</h4>
          <JsonTree value={input} />
        </section>
      )}
      {output !== null && output !== undefined && (
        <section className="tool-body-section">
          <h4>输出</h4>
          {typeof output === 'object' ? <JsonTree value={output} /> : <pre className="web-content">{String(output)}</pre>}
        </section>
      )}
      {plainText && output === null && <pre className="web-content">{plainText}</pre>}
      {!hasInput && (output === null || output === undefined) && !plainText && <div className="tool-body-empty">没有可展示的内容</div>}
    </div>
  );
});

const BODY_BY_CARD = {
  terminal: TerminalBody,
  code: CodeBody,
  file: FileBody,
  diff: DiffBody,
  search: SearchBody,
  web: WebBody,
  plan: PlanBody,
  capability: CapabilityBody,
  generic: GenericBody,
};

function signFor(type) {
  if (type === 'add') return '+';
  if (type === 'del') return '−';
  if (type === 'hunk') return '@';
  if (type === 'meta') return ' ';
  return ' ';
}
