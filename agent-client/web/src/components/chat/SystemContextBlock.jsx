import { memo, useMemo, useState } from 'react';
import { ChevronRightIcon, ContextIcon } from '../common/icons.jsx';

const KIND_LABEL = {
  'agent-prompt': 'Agent prompt',
  'agent-guidance': 'Runtime guidance',
  'core-tools': 'Core tool catalog',
  'tool-library': 'Tool library domains',
  'cli-tools': 'Installed CLIs',
  workspace: 'Project workspace',
};

/**
 * 系统提示词归因行：与工具行、思维链行共享同一套折叠行几何（见 ThinkingBlock 的说明）。
 *
 * 原文取该 run 第一次请求的 `messages[0]`——读侧用记录下来的偏移去切片，所以这里显示的
 * 就是模型当时真正看到的那一份。分段偏移在**拼装时**产生（`buildRuntimeSystemPrompt`），
 * 不靠事后拿配置文件比对：`agents.json` / `prompts/*.md` / `llm.json` / `mcp.json` 每次
 * resolve 都无缓存重读，事后比对会把今天的文件算到昨天的请求头上。
 */
export const SystemContextBlock = memo(function SystemContextBlock({ blockKey, prompt }) {
  const [expanded, setExpanded] = useState(false);
  const sections = prompt?.sections || [];
  const text = prompt?.text || '';
  const rows = useMemo(() => sections.map((section) => ({
    key: `${section.kind}-${section.start}`,
    label: KIND_LABEL[section.kind] || section.kind,
    source: section.source,
    chars: Math.max(0, section.end - section.start),
  })), [sections]);

  if (!text) return null;
  const bodyId = `${blockKey || 'system-context'}-body`;

  return (
    <div className="tool-card-row">
      <button
        type="button"
        className="tool-card"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        {/* 工具行第一列是状态点；这一行没有状态，留空以保持图标对齐。 */}
        <span aria-hidden="true" />
        <span className="tool-card-icon"><ContextIcon /></span>
        <span className="tool-card-main">
          <span className="tool-card-title">System context</span>
        </span>
        <span className="tool-card-summary">{text.length} 字符 · {rows.length} 段</span>
        <span className="tool-card-chevron"><ChevronRightIcon /></span>
      </button>
      {expanded && (
        <div className="tool-card-body" id={bodyId}>
          <ul className="system-context-sections">
            {rows.map((row) => (
              <li key={row.key}>
                <span className="system-context-kind">{row.label}</span>
                <span className="system-context-source">{row.source}</span>
                <span className="system-context-chars">{row.chars} 字符</span>
              </li>
            ))}
          </ul>
          <pre className="system-context-text">{text}</pre>
        </div>
      )}
    </div>
  );
});
