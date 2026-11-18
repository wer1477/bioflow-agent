import { memo, useEffect, useRef, useState } from 'react';
import {
  activityDetail,
  activityLabel,
  contextNote,
  contextSegments,
  usageDetail,
  usageLabel,
} from '../../domain/conversation_stats.js';
import { formatTokenCount } from '../../format.js';
import { DatabaseIcon, GaugeIcon } from '../common/icons.jsx';

/** SVG 环：14px viewBox、2px 描边；半径 5.5 时周长约 34.56。 */
const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 上下文药丸：环形占用 + 百分比，点击展开三分类面板。
 *
 * `<button aria-expanded>` 是唯一可交互元素；外部 pointerdown 与 Escape 都会关闭，
 * 面板右对齐药丸，避免在窄屏或右侧 dock 展开时被裁掉。
 */
function ContextMeter({ context }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const percent = Math.max(0, Math.min(100, Math.round(Number(context.percent) || 0)));
  const segments = contextSegments(context);
  const note = contextNote(context);
  // 团队根会话报的是当前角色的窗口，读数离开角色就没有意义，名字跟着一起显示。
  const roleLabel = context.agentLabel ? String(context.agentLabel) : '';
  const label = `上下文已用 ${percent}%${roleLabel ? `（${roleLabel}）` : ''}`;

  return (
    <span className="composer-stat-root" ref={rootRef}>
      <button
        type="button"
        className="composer-stat-pill composer-stat-context"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="composer-stat-ring" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="composer-stat-ring-track" cx="7" cy="7" r={RING_RADIUS} />
          <circle
            className="composer-stat-ring-fill"
            cx="7"
            cy="7"
            r={RING_RADIUS}
            strokeDasharray={`${(RING_CIRCUMFERENCE * percent) / 100} ${RING_CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
        <span>{percent}%</span>
      </button>
      {open ? (
        <div className="composer-stat-panel" role="dialog" aria-label="上下文占用">
          <div className="composer-stat-panel-head">
            <span>上下文已用{roleLabel ? ` · ${roleLabel}` : ''}</span>
            <strong>{percent}%</strong>
            <span className="composer-stat-panel-figures">
              ~{formatTokenCount(context.usedTokens)} / {formatTokenCount(context.contextWindowTokens)}
            </span>
          </div>
          <div className="composer-stat-bar" aria-hidden="true">
            {segments.filter((segment) => segment.width > 0).map((segment) => (
              <span
                key={segment.key}
                className={`composer-stat-bar-segment composer-stat-bar-${segment.key}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          <dl className="composer-stat-rows">
            {segments.map((segment) => (
              <div key={segment.key} className="composer-stat-row">
                <dt>
                  <span className={`composer-stat-swatch composer-stat-swatch-${segment.key}`} aria-hidden="true" />
                  {segment.label}
                </dt>
                <dd>~{formatTokenCount(segment.tokens)}</dd>
              </div>
            ))}
          </dl>
          {note ? <p className="composer-stat-note">{note}</p> : null}
        </div>
      ) : null}
    </span>
  );
}

/**
 * 输入框下方的会话统计（DSH `StatsPills` 语法）：活动 / token 用量 / 上下文占用。
 *
 * 统计未返回或请求失败时只保留一行高度，不渲染空药丸，也不让 composer 上下跳动。
 */
export const ComposerStats = memo(function ComposerStats({ stats }) {
  if (!stats || stats.error) return <div className="composer-stats" />;

  const activity = activityLabel(stats.activity);
  const usage = usageLabel(stats.tokenUsage);
  return (
    <div className="composer-stats">
      {activity ? (
        <span className="composer-stat-pill" data-tooltip={activityDetail(stats.activity)}>
          <GaugeIcon />
          <span>{activity}</span>
        </span>
      ) : null}
      {usage ? (
        <span className="composer-stat-pill" data-tooltip={usageDetail(stats.tokenUsage)}>
          <DatabaseIcon />
          <span>{usage}</span>
        </span>
      ) : null}
      {stats.context ? <ContextMeter context={stats.context} /> : null}
    </div>
  );
});
