import { memo, useState } from 'react';

const AUTO_EXPAND_DEPTH = 2;

/**
 * 可折叠 JSON 树：替代裸 <pre> 打原始 JSON。
 * 只在容器内展开/收起，不依赖外部状态。
 */
export const JsonTree = memo(function JsonTree({ value, name = '', depth = 0 }) {
  if (value === null || value === undefined) return <Primitive name={name} value={null} />;
  if (typeof value !== 'object') return <Primitive name={name} value={value} />;

  return <Branch name={name} value={value} depth={depth} />;
});

const Branch = memo(function Branch({ name, value, depth }) {
  const isArray = Array.isArray(value);
  const entries = isArray
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const [open, setOpen] = useState(depth < AUTO_EXPAND_DEPTH);
  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;

  if (!entries.length) {
    return (
      <div className="json-tree-row">
        {name && <span className="json-tree-key">{name}</span>}
        <span className="json-tree-punct">{isArray ? '[]' : '{}'}</span>
      </div>
    );
  }

  return (
    <div className="json-tree-branch">
      <button
        className="json-tree-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`json-tree-caret${open ? ' open' : ''}`} aria-hidden="true" />
        {name && <span className="json-tree-key">{name}</span>}
        <span className="json-tree-summary">{summary}</span>
      </button>
      {open && (
        <div className="json-tree-children">
          {entries.map(([key, child]) => (
            <JsonTree key={key} name={key} value={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
});

const Primitive = memo(function Primitive({ name, value }) {
  return (
    <div className="json-tree-row">
      {name && <span className="json-tree-key">{name}</span>}
      <span className={`json-tree-value json-tree-${typeOf(value)}`}>{format(value)}</span>
    </div>
  );
});

function typeOf(value) {
  if (value === null) return 'null';
  return typeof value;
}

function format(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}
