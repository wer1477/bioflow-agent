import { memo, useState } from 'react';
import { ChevronRightIcon, ThinkingIcon } from '../common/icons.jsx';
import { Markdown } from './Markdown.jsx';

/**
 * 思维链行：默认折叠，与工具行共享同一套折叠行几何。
 *
 * 复用 `.tool-card*` 的类名是刻意的——它就是同一种「轨迹行」，只是内容不同。自己再写一套
 * `.thinking-*` 的边框/高度/字号只会得到第二种折叠行风格（曾经就是这样：带边框的盒子 +
 * 左侧图标，夹在无边框、右侧 chevron 的工具行中间，非常突兀）。
 *
 * 内容可能很长（一次 run 的推理可达数万字符），所以折叠时不渲染正文，展开时才走 markdown。
 */
export const ThinkingBlock = memo(function ThinkingBlock({ blockKey, content }) {
  const [expanded, setExpanded] = useState(false);
  const text = String(content || '');
  if (!text) return null;
  const bodyId = `${blockKey || 'thinking'}-body`;

  return (
    <div className="tool-card-row">
      <button
        type="button"
        className="tool-card"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        {/* 工具行第一列是状态点；思维链没有状态，留空以保持图标与工具图标对齐。 */}
        <span aria-hidden="true" />
        <span className="tool-card-icon"><ThinkingIcon /></span>
        <span className="tool-card-main">
          <span className="tool-card-title">思考</span>
        </span>
        <span className="tool-card-summary">{text.length} 字符</span>
        <span className="tool-card-chevron"><ChevronRightIcon /></span>
      </button>
      {expanded && (
        <div className="tool-card-body" id={bodyId}>
          <div className="thinking-body">
            <Markdown content={text} />
          </div>
        </div>
      )}
    </div>
  );
});
