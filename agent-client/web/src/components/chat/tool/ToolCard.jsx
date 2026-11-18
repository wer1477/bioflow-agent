import { memo, useState } from 'react';
import { toolCardModel } from '../../../domain/tool_kind.js';
import { JsonTree } from '../../common/JsonTree.jsx';
import { StateDot } from '../../common/StateDot.jsx';
import {
  CapabilityIcon, ChevronRightIcon, CodeIcon, DiffIcon, FileIcon, GenericIcon,
  PlanIcon, SearchIcon, TerminalIcon, WebIcon,
} from '../../common/icons.jsx';
import { ToolCardBody } from './toolBodies.jsx';

const ICON_BY_CARD = {
  terminal: TerminalIcon,
  code: CodeIcon,
  diff: DiffIcon,
  file: FileIcon,
  search: SearchIcon,
  web: WebIcon,
  plan: PlanIcon,
  capability: CapabilityIcon,
  generic: GenericIcon,
};

/** 卡片类型 → 图标。 */
function CardIcon({ card }) {
  const Component = ICON_BY_CARD[card] || GenericIcon;
  return <Component />;
}

/**
 * 工具调用的一行：折叠态是 24px 的 header，详情展开体就地插在它正下方。
 *
 * header 与 body 必须是兄弟节点——header 是 <button>（里面不能嵌交互内容），
 * 它的 24px 固定高度 + `contain: size` 也会把展开体直接裁掉。
 * 展开体收起即卸载：里面的 highlight.js 与 JSON 树不必常驻。
 */
export const ToolCard = memo(function ToolCard({ item, expanded, onToggleTool, onOpenFile }) {
  const model = toolCardModel(item);
  const detail = model.summary || model.subtitle || '';
  const bodyId = `${item.key}-tool-body`;

  return (
    <div className="tool-card-row">
      <button
        type="button"
        className={`tool-card${model.status === 'running' ? ' is-running' : ''}${model.dotState === 'error' ? ' is-error' : ''}`}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={(event) => onToggleTool(item, event.currentTarget)}
      >
        <StateDot state={model.dotState} />
        <span className="tool-card-icon"><CardIcon card={model.card} /></span>
        <span className="tool-card-main">
          <span className="tool-card-title">{model.title}</span>
          {model.subtitle && <span className="tool-card-subtitle">{model.subtitle}</span>}
        </span>
        {detail && <span className="tool-card-summary">{detail}</span>}
        <span className="tool-card-chevron"><ChevronRightIcon /></span>
      </button>
      {expanded && (
        <div className="tool-card-body" id={bodyId}>
          <ToolCardBody model={model} onOpenFile={onOpenFile} />
          <ToolCardRaw raw={item.raw} />
        </div>
      )}
    </div>
  );
});

/** 「原始事件」折叠项：开关状态随 body 一起卸载，重新展开时回到收起态。 */
const ToolCardRaw = memo(function ToolCardRaw({ raw }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-card-raw">
      <button
        className="disclosure-row"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`disclosure-caret${open ? ' open' : ''}`} aria-hidden="true" />
        <span className="disclosure-title">原始事件</span>
      </button>
      {open && <div className="tool-card-raw-body"><JsonTree value={raw} /></div>}
    </div>
  );
});
