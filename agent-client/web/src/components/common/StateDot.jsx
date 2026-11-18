import { memo } from 'react';

/**
 * 状态点：done / warning / error / idle 是 6px 的 currentColor 圆点，
 * running 是一个 1.5s 周期的旋转弧 + dasharray 呼吸。
 * 几何抄自 DSH 的 StateDot：外框保持固定布局槽，颜色只由状态决定。
 */
export const StateDot = memo(function StateDot({ state = 'idle', label }) {
  if (state === 'running') {
    return (
      <span className="state-dot running" role="status" aria-label={label || '运行中'}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle className="state-dot-track" cx="8" cy="8" r="6" />
          <circle className="state-dot-arc" cx="8" cy="8" r="6" />
        </svg>
      </span>
    );
  }
  return <span className={`state-dot ${state}`} role="img" aria-label={label || stateLabel(state)} />;
});

function stateLabel(state) {
  return ({ done: '已完成', warning: '警告', error: '失败', idle: '空闲' })[state] || '状态';
}
