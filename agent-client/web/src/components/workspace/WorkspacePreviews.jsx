import { memo, useMemo } from 'react';
import { AssistantMarkdown } from '../../assistant_markdown.js';
import { CodeBlock } from '../common/CodeBlock.jsx';

/** 超过这个行数就不再跑 highlight.js：和 CodeEditor 的上限保持一致，大文件优先保证可读性。 */
const HIGHLIGHT_MAX_LINES = 2000;
/** 超过这个行数让浏览器跳过屏外渲染（CSS content-visibility），不再自己做虚拟列表。 */
const DENSE_ROW_THRESHOLD = 2000;
const NOTEBOOK_CELL_LIMIT = 200;

/** 预览分派：按视图类型挑渲染器；图片/PDF 由调用方直接渲染，不经过这里。 */
export const WorkspacePreview = memo(function WorkspacePreview({ view, preview, wrapText }) {
  if (!view || !preview) return null;
  // 分派用 viewKind：hex 这类"由编码决定"的视图和按扩展名判定的 kind 可能不同。
  const kind = view.viewKind;
  if (kind === 'notebook') return <WorkspaceNotebookPreview preview={preview} />;
  if (kind === 'markdown') {
    return <div className="workspace-markdown-preview"><AssistantMarkdown content={preview.lines.join('\n')} /></div>;
  }
  if (kind === 'vcf') return <WorkspaceVcfPreview preview={preview} />;
  if (kind === 'table') return <WorkspaceTablePreview preview={preview} label="数据表" />;
  if (kind === 'gff' || kind === 'bed' || kind === 'sam') {
    return <WorkspaceAnnotatedTablePreview preview={preview} kind={kind} />;
  }
  if (kind === 'fasta') return <WorkspaceFastaPreview preview={preview} />;
  if (kind === 'fastq') return <WorkspaceFastqPreview preview={preview} />;
  if (kind === 'hex') return <WorkspaceHexPreview preview={preview} />;
  return (
    <WorkspaceCodePreview
      lines={preview.lines || []}
      wrapText={wrapText}
      language={view.language}
      invalidJson={kind === 'json' && !preview.valid}
      truncated={preview.truncated}
      totalLines={preview.totalLines}
    />
  );
});

const PreviewStats = memo(function PreviewStats({ title, items = [], children }) {
  return (
    <div className="workspace-data-summary">
      <div>
        <strong>{title}</strong>
        {items.length > 0 && (
          <span className="workspace-data-metrics">
            {items.map((item) => <span key={item.label}>{item.label}<b>{item.value}</b></span>)}
          </span>
        )}
      </div>
      {children}
    </div>
  );
});

export const WorkspaceVcfPreview = memo(function WorkspaceVcfPreview({ preview }) {
  return (
    <div className="workspace-data-preview">
      <PreviewStats title="VCF 变异数据" items={[{ label: '记录', value: preview.totalRows.toLocaleString() }]}>
        {preview.truncated && <span>仅显示前 {preview.rows.length.toLocaleString()} 条</span>}
      </PreviewStats>
      {preview.metadata.length > 0 && (
        <details className="workspace-vcf-metadata">
          <summary>文件元数据 · {preview.metadata.length} 项</summary>
          <ul>{preview.metadata.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
        </details>
      )}
      <WorkspaceTablePreview preview={preview} label="变异记录" />
    </div>
  );
});

/** GFF/BED/SAM 共用的"统计 + 表格"骨架。 */
export const WorkspaceAnnotatedTablePreview = memo(function WorkspaceAnnotatedTablePreview({ preview, kind }) {
  const items = useMemo(() => {
    if (kind === 'sam') {
      return [
        { label: '记录', value: preview.totalRows.toLocaleString() },
        { label: '已比对', value: preview.mapped.toLocaleString() },
        { label: '未比对', value: preview.unmapped.toLocaleString() },
      ];
    }
    return [{ label: '记录', value: preview.totalRows.toLocaleString() }];
  }, [kind, preview.mapped, preview.totalRows, preview.unmapped]);

  const title = { gff: '注释区间', bed: '区间记录', sam: '比对记录' }[kind] || '记录';
  return (
    <div className="workspace-data-preview">
      <PreviewStats title={title} items={items}>
        {preview.truncated && <span>仅显示前 {preview.rows.length.toLocaleString()} 行</span>}
      </PreviewStats>
      {preview.metadata?.length > 0 && (
        <details className="workspace-vcf-metadata">
          <summary>文件头 · {preview.metadata.length} 行</summary>
          <ul>{preview.metadata.slice(0, 60).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
        </details>
      )}
      {preview.header?.length > 0 && (
        <details className="workspace-vcf-metadata">
          <summary>比对头 · {preview.header.length} 行</summary>
          <ul>{preview.header.slice(0, 60).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
        </details>
      )}
      {preview.features?.length > 0 && (
        <div className="workspace-feature-chips">
          {preview.features.map((feature) => (
            <span key={feature.type}>{feature.type}<b>{feature.count.toLocaleString()}</b></span>
          ))}
        </div>
      )}
      <WorkspaceTablePreview preview={preview} label={title} />
    </div>
  );
});

export const WorkspaceFastaPreview = memo(function WorkspaceFastaPreview({ preview }) {
  return (
    <div className="workspace-data-preview">
      <PreviewStats
        title="FASTA 序列"
        items={[
          { label: '记录', value: preview.totalRecords.toLocaleString() },
          { label: '总碱基', value: preview.totalBases.toLocaleString() },
          { label: '最短', value: preview.minLength.toLocaleString() },
          { label: '平均', value: preview.meanLength.toLocaleString() },
          { label: '最长', value: preview.maxLength.toLocaleString() },
        ]}
      >
        {preview.truncated && <span>仅显示前 {preview.records.length.toLocaleString()} 条</span>}
      </PreviewStats>
      <div className="workspace-record-list">
        {preview.records.map((record) => (
          <div className="workspace-record" key={`${record.id}-${record.length}`}>
            <div className="workspace-record-head">
              <code>{record.id || '未命名记录'}</code>
              <span>{record.length.toLocaleString()} bp</span>
            </div>
            <pre>{record.preview}</pre>
          </div>
        ))}
        {preview.records.length === 0 && <p className="workspace-preview-empty">没有解析到序列记录。</p>}
      </div>
    </div>
  );
});

export const WorkspaceFastqPreview = memo(function WorkspaceFastqPreview({ preview }) {
  return (
    <div className="workspace-data-preview">
      <PreviewStats
        title="FASTQ 测序读段"
        items={[
          { label: '读段', value: preview.totalReads.toLocaleString() },
          { label: '总碱基', value: preview.totalBases.toLocaleString() },
          { label: '平均长度', value: preview.meanLength.toLocaleString() },
          { label: 'GC', value: `${preview.gcContent}%` },
          { label: '平均质量', value: `Q${preview.meanQuality}` },
        ]}
      >
        {preview.truncated && <span>仅显示前 {preview.reads.length.toLocaleString()} 条</span>}
      </PreviewStats>
      <div className="workspace-record-list">
        {preview.reads.map((read) => (
          <div className="workspace-record" key={`${read.id}-${read.length}`}>
            <div className="workspace-record-head">
              <code>{read.id}</code>
              <span>{read.length} bp · GC {read.gc}% · Q{read.meanQuality}</span>
            </div>
            <pre>{read.sequence}</pre>
            <pre className="workspace-quality">{read.quality}</pre>
          </div>
        ))}
        {preview.reads.length === 0 && <p className="workspace-preview-empty">没有解析到 FASTQ 读段。</p>}
      </div>
    </div>
  );
});

export const WorkspaceHexPreview = memo(function WorkspaceHexPreview({ preview }) {
  return (
    <div className="workspace-data-preview">
      <PreviewStats title="二进制内容" items={[{ label: '显示字节', value: preview.bytes.toLocaleString() }]}>
        {preview.truncated && <span>仅显示文件开头</span>}
      </PreviewStats>
      <div className="workspace-hex">
        {preview.rows.map((row) => (
          <div className="workspace-hex-row" key={row.offset}>
            <span className="workspace-hex-offset">{row.offset}</span>
            <span className="workspace-hex-bytes">{row.hex}</span>
            <span className="workspace-hex-ascii">{row.ascii}</span>
          </div>
        ))}
        {preview.rows.length === 0 && <p className="workspace-preview-empty">没有可显示的内容。</p>}
      </div>
    </div>
  );
});

export const WorkspaceNotebookPreview = memo(function WorkspaceNotebookPreview({ preview }) {
  if (!preview.valid) {
    return <WorkspaceCodePreview lines={['这个 .ipynb 不是合法的 JSON，已按文本显示。']} />;
  }
  const cells = preview.cells.slice(0, NOTEBOOK_CELL_LIMIT);
  return (
    <div className="workspace-notebook">
      {(preview.kernel || preview.language) && (
        <PreviewStats
          title="Notebook"
          items={[
            ...(preview.kernel ? [{ label: '内核', value: preview.kernel }] : []),
            { label: '单元格', value: preview.cells.length.toLocaleString() },
          ]}
        />
      )}
      {cells.map((cell, index) => (
        <section className={`workspace-notebook-cell is-${cell.type}`} key={index}>
          <header>
            <span>{cell.type === 'code' ? `[${index + 1}]` : cell.type === 'markdown' ? 'MD' : 'RAW'}</span>
          </header>
          {cell.type === 'markdown'
            ? <div className="workspace-notebook-markdown"><AssistantMarkdown content={cell.source} /></div>
            : <pre className="workspace-notebook-source">{cell.source}</pre>}
          {cell.outputs?.map((output, outputIndex) => (
            <pre className="workspace-notebook-output" key={outputIndex}>{output}</pre>
          ))}
        </section>
      ))}
      {preview.cells.length > cells.length && (
        <p className="workspace-preview-note">为保证阅读性能，仅显示前 {cells.length} 个单元格。</p>
      )}
    </div>
  );
});

export const WorkspaceTablePreview = memo(function WorkspaceTablePreview({ preview, label }) {
  if (!preview.columns.length) return <WorkspaceCodePreview lines={['此文件不含可识别的表头。']} />;
  return (
    <div className="workspace-table-region" aria-label={label}>
      <table className="workspace-data-table">
        <thead><tr>{preview.columns.map((column, index) => <th key={`${column}-${index}`}>{column || `列 ${index + 1}`}</th>)}</tr></thead>
        <tbody>{preview.rows.map((row, rowIndex) => (
          <tr key={`${rowIndex}-${row.join('\u0000')}`}>{preview.columns.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ''}</td>)}</tr>
        ))}</tbody>
      </table>
      {preview.rows.length === 0 && <p className="workspace-preview-empty">未找到数据行。</p>}
      {preview.truncated && <p className="workspace-preview-note">为保证阅读性能，仅显示前 {preview.rows.length.toLocaleString()} 行。</p>}
    </div>
  );
});

/**
 * 代码/纯文本预览。
 *
 * 只有一个滚动容器：外层 `.workspace-file-body`。这里既不再套一个自己的滚动区，
 * 也不再自己做虚拟列表——预览上限本来就只有 5000 行，行数多时交给
 * `content-visibility` 让浏览器跳过屏外行，比自己维护 `scrollTop` + `translateY` 更准。
 *
 * 两条渲染分支共用同一套行高与配色约定：
 * - 有语言且行数不超上限 → `CodeBlock`（深色代码面板，高亮）；
 * - 其余 → `<ol>` 行号列表（底色随主题，纯文本）。
 * 大文件不跑 highlight.js 是刻意的：5000 行高亮会卡住打开文件的第一步。
 */
export const WorkspaceCodePreview = memo(function WorkspaceCodePreview({
  lines = [], wrapText = false, language = '', invalidJson = false, truncated = false, totalLines = 0,
}) {
  const highlighted = Boolean(language) && lines.length <= HIGHLIGHT_MAX_LINES;
  const dense = lines.length > DENSE_ROW_THRESHOLD;
  const className = [
    'workspace-code-preview',
    wrapText ? 'is-wrapped' : '',
    highlighted ? 'is-dark' : '',
    dense ? 'is-dense' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={className}>
      {invalidJson && <p className="workspace-preview-warning">JSON 格式无效，已按原始文本显示。</p>}
      {highlighted
        ? (
          <CodeBlock
            code={lines.join('\n')}
            language={language}
            showHeader={false}
            showCopy={false}
            wrap={wrapText}
          />
        )
        : (
          <ol>
            {lines.map((line, index) => <li key={index}><code>{line || ' '}</code></li>)}
          </ol>
        )}
      {truncated && <p className="workspace-preview-note">为保证阅读性能，仅显示前 {lines.length.toLocaleString()} / {totalLines.toLocaleString()} 行。</p>}
    </div>
  );
});
