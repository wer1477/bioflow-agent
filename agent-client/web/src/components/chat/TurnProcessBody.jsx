import { useCallback, useEffect, useRef, useState } from 'react';
import { scrollEdges } from '../../domain/message_scroll.js';

const BOTH_ENDS = { atTop: true, atBottom: true };

/**
 * 一轮展开后的过程体：高度封顶，超出的内容在这个盒子内部滚动。
 *
 * 折叠行是它的**兄弟节点**，永远留在滚动盒外面——这正是「下滑很久之后还要滑回去才能
 * 收起」的解法：过程再长也只占 min(400px, 50vh)，行始终就在窗口上沿。
 *
 * 边缘渐隐只是"这里还能滚"的提示，所以要跟着真实滚动位置开关：到顶时上边不淡、
 * 到底时下边不淡（判据见 domain/message_scroll.js 的 scrollEdges）。
 */
export function TurnProcessBody({ id, children }) {
  const ref = useRef(null);
  const [edges, setEdges] = useState(BOTH_ENDS);

  const measure = useCallback(() => {
    const next = scrollEdges(ref.current);
    setEdges((current) => (current.atTop === next.atTop && current.atBottom === next.atBottom ? current : next));
  }, []);

  // 展开体里再展开一张工具卡会改变高度，所以每次渲染后都重量一次（三次属性读取，很便宜）。
  useEffect(measure);

  return (
    <div
      ref={ref}
      id={id}
      className="turn-process-body"
      data-fade-top={edges.atTop ? undefined : ''}
      data-fade-bottom={edges.atBottom ? undefined : ''}
      onScroll={measure}
    >
      {children}
    </div>
  );
}
