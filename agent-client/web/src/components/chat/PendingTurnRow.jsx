import { memo, useEffect, useState } from 'react';
import { formatElapsed } from '../../domain/turn_process.js';

/**
 * 本轮第一条过程行出现之前的等待行。
 *
 * 它只回答一个问题：「消息到了，Agent 现在在哪一步」。所以文案来自真实 run_status，
 * 右侧只给已经等待的时间——不做进度条，也不猜剩余时间。
 *
 * 计时器放在组件内部：只有这一行每秒重渲染，不会带着整棵消息树一起重绘。
 */
export const PendingTurnRow = memo(function PendingTurnRow({ phase = 'sending', label = '正在运行…', startedAt = 0 }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsedMs = startedAt > 0 ? Math.max(0, now - startedAt) : 0;

  return (
    <div className="turn-pending" role="status" aria-live="polite" data-phase={phase}>
      {/* 样本珠沿微流道单向通过：只前进、不转圈，和工具行的旋转状态点区分开。
          reduced-motion 时珠子停在流道中段，仍然读得出「一颗粒子」的形状。 */}
      <span className="turn-pending-signal pt-channel" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path className="pt-rail" d="M2.5 8h11" />
          <circle className="pt-node" cx="2.5" cy="8" r="0.9" opacity="0.5" />
          <circle className="pt-node" cx="13.5" cy="8" r="0.9" opacity="0.5" />
          <circle className="pt-bead bead-b" cx="0" cy="8" r="1.15" />
          <circle className="pt-bead bead-a" cx="0" cy="8" r="1.65" />
        </svg>
      </span>
      <span className="turn-pending-label">{label}</span>
      {/* 秒数变化不该被读屏逐秒播报，视觉上保留即可。 */}
      {elapsedMs >= 1000 && (
        <span className="turn-pending-elapsed" aria-hidden="true">{formatElapsed(elapsedMs)}</span>
      )}
    </div>
  );
});
