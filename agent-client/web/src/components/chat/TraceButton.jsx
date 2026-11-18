import { memo } from 'react';
import { ToolCard } from './tool/ToolCard.jsx';

/**
 * 工具调用在消息流里的一行：类型化卡片（状态点 + 图标 + 标题 + 摘要），
 * 详情就地展开在行下方。
 * props 契约：item / expanded / onToggleTool。
 */
export const TraceButton = memo(function TraceButton({ item, expanded, onToggleTool, onOpenFile }) {
  return <ToolCard item={item} expanded={expanded} onToggleTool={onToggleTool} onOpenFile={onOpenFile} />;
});
