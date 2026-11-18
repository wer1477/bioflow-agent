import { ChevronDownIcon } from '../common/icons.jsx';

/**
 * 一轮任务收起后的那一行：答案上方的整宽 disclosure。
 *
 * 与工具行刻意不同几何（见 chat.css 的 `.turn-process*`）：工具行是 24px 的过程细节，
 * 这一行是「整轮过程」的入口，两者必须一眼分得开——把整轮折叠做成和工具行一样高，
 * 用户会分不清点开的是哪一个层级（`ThinkingBlock` 的注释里记过同一类坑）。
 *
 * 点击后 `focus()`：行本身是 `<button>`，折叠会让焦点所在的展开体消失，
 * 不重新聚焦的话键盘用户会掉回 body。
 *
 * 不额外渲染 `role="status"` 播报：行上的文字已经是这个按钮的可访问名，再挂一个 live
 * region 会让读屏器把同一句读两遍，而且历史会话一次性挂载时会把每一轮都播报一遍。
 * 折叠本身不是"必须立刻告知"的事件——侧栏已经有完成点了。
 */
export function TurnProcessRow({ label, open, bodyId, onToggle }) {
  return (
    <button
      type="button"
      className="turn-process"
      // 可见文字里没有"过程"二字，补进可访问名，否则读屏器只念出"完成了多久"。
      aria-label={`${label}，${open ? '收起过程' : '展开过程'}`}
      aria-expanded={open}
      // 展开体只在展开时存在：折叠态指一个不存在的 id 比不给更糟。
      aria-controls={open ? bodyId : undefined}
      onClick={(event) => {
        const row = event.currentTarget;
        row.focus();
        onToggle(row);
      }}
    >
      <span className="turn-process-label">{label}</span>
      <span className="turn-process-chevron" aria-hidden="true"><ChevronDownIcon /></span>
    </button>
  );
}
