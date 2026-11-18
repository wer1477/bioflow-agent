import { memo, useMemo, useRef, useState } from 'react';
import { copyToClipboard } from '../../clipboard.js';
import { CheckIcon, CloseIcon, CopyMessageIcon } from '../common/icons.jsx';
import { buildMessageParts, findUnrenderedNarration } from '../../domain/trace.js';
import { canCopyAssistantMessage } from '../../domain/message_copy_state.js';
import { traceExpansionId } from '../../domain/tool_expansion.js';
import {
  countSteps, DEFAULT_COLLAPSE_TIMING, isCompletedRun, resolveTurnProcessOpen, runStatusLabel,
  splitTurnProcess, turnProcessLabel,
} from '../../domain/turn_process.js';
import { Markdown } from './Markdown.jsx';
import { PlanningPanel } from './PlanningPanel.jsx';
import { SecurityApprovalPanel } from './SecurityApprovalPanel.jsx';
import { SystemContextBlock } from './SystemContextBlock.jsx';
import { ThinkingBlock } from './ThinkingBlock.jsx';
import { TraceButton } from './TraceButton.jsx';
import { TurnProcessBody } from './TurnProcessBody.jsx';
import { TurnProcessRow } from './TurnProcessRow.jsx';

const NOTHING_EXPANDED = new Set();

export const FlowMessage = memo(function FlowMessage({
  message,
  roleLabel = '',
  showRoleDivider = false,
  traceItems = [],
  traceNamespace,
  traceRunId = '',
  expandedToolIds = NOTHING_EXPANDED,
  onToggleTool,
  onPlanningResponse,
  onSecurityApproval,
  onOpenFile,
  resolveOpenablePath,
  // 整轮折叠：时机偏好、本消息是否为「最新一个成功轮次」、手动开合记录与写入。
  foldTiming = DEFAULT_COLLAPSE_TIMING,
  isLatestCompleted = false,
  processOpenOverride,
  onToggleProcess,
}) {
  const [copyState, setCopyState] = useState(null);
  // 结果块：折叠/展开后要把它的屏幕位置钉回去（由 ChatView 的滚动补偿使用）。
  const answerRef = useRef(null);
  const run = message.toolCalls?.run;
  const namespace = traceNamespace || `message-${message.id || 'live'}`;
  // 运行中的消息没有持久 runId，由 ChatView 从 live 事件流里取（见 domain/trace.js 的 findRunId），
  // 这样工具行的展开标识在 run 结束后重拉消息时依然对得上。
  const runId = run?.runId || traceRunId || '';

  // The ordered event stream is the primary source for assistant text: the read side
  // rebuilds narration from `model_response` at the position it originally had, so the
  // parts below already interleave text with tool rows.
  //
  // `message.content` is a single concatenated string with no positions and is therefore
  // never rendered as the narration itself — appending it after the parts is what pushed
  // interleaved narration to the end of the message. It is still read in two cases:
  // when the run has no rebuilt events at all (missing or damaged transcript, or a
  // message stored before run events were derived), and for any text the parts do not
  // account for — a run killed mid-turn persists its partial content but has no
  // `model_response` record yet, and that tail must not be dropped.
  //
  // 一次性算完：这条消息在会话里可能驻留很久，每次父组件重渲染都重跑
  // `findUnrenderedNarration` 的正文相减是没有必要的开销。
  const { parts, text, fold, steps } = useMemo(() => {
    const built = message.role === 'assistant'
      ? buildMessageParts(run?.events || [], run?.plan, namespace, runId)
      : [];
    const hasNarrationParts = built.some((part) => part.type === 'text' && part.content);
    const unaccountedText = hasNarrationParts ? findUnrenderedNarration(message.content, built) : '';
    return {
      parts: built,
      text: hasNarrationParts ? unaccountedText : message.content || '',
      // 过程/结果分区只认 parts：正文串没有位置信息，切不出来。
      fold: splitTurnProcess(built, message.content),
      steps: countSteps(built),
    };
  }, [message.role, message.content, namespace, run?.events, run?.plan, runId]);

  // 只有成功结束的轮次才收：失败与用户中断的那一轮恰恰是最需要看清过程的时候。
  const completed = isCompletedRun(run);
  const collapsible = fold.foldable && completed;
  const open = resolveTurnProcessOpen({
    foldable: fold.foldable,
    completed,
    timing: foldTiming,
    isLatest: isLatestCompleted,
    override: processOpenOverride,
  });
  const processBodyId = `${namespace}-process`;

  const handleCopy = async (role, content) => {
    const ok = await copyToClipboard(content);
    setCopyState({ role, ok });
    setTimeout(() => setCopyState((current) => (current?.role === role ? null : current)), 1500);
  };

  if (message.role !== 'assistant') {
    const copied = copyState?.role === 'user';
    const copiedOk = copied && copyState.ok;
    return (
      <>
        {showRoleDivider && <RoleDivider label={roleLabel} />}
        <article className={`message ${message.role}`}>
          <div className="message-user-actions">
            <CopyMessageButton copied={copied} copiedOk={copiedOk} onCopy={() => handleCopy('user', text)} />
          </div>
          {text}
        </article>
      </>
    );
  }
  if (!text && !traceItems.length && !parts.length) return null;

  const copied = copyState?.role === 'assistant';
  const copiedOk = copied && copyState.ok;
  const canCopy = canCopyAssistantMessage(message, { isLive: traceNamespace === 'live' });
  const copyAssistant = () => {
    const partsText = parts.filter((part) => part.type === 'text').map((part) => part.content).join('\n');
    const copyText = message.content || partsText || text || '';
    handleCopy('assistant', copyText);
  };
  const statusLabel = runStatusLabel(run);

  /** 一个 part 在消息流里的样子；折叠与否只决定渲染哪一段序列，不改变单个 part 的渲染。 */
  const renderPart = (part) => (
    part.type === 'trace' ? (
      <TraceButton
        key={part.item.key}
        item={part.item}
        expanded={expandedToolIds.has(traceExpansionId(part.item))}
        onToggleTool={onToggleTool}
        onOpenFile={onOpenFile}
      />
    ) : part.type === 'planning' ? (
      <PlanningPanel key={part.key} panel={part.panel} onRespond={onPlanningResponse} />
    ) : part.type === 'security_approval' ? (
      <SecurityApprovalPanel key={part.key} request={part.request} onRespond={onSecurityApproval} />
    ) : part.type === 'thinking' ? (
      <ThinkingBlock key={part.key} blockKey={part.key} content={part.content} />
    ) : (
      <div key={part.key} className="message-content"><Markdown content={part.content} onOpenFile={onOpenFile} resolveOpenablePath={resolveOpenablePath} /></div>
    )
  );

  return (
    <>
      {showRoleDivider && <RoleDivider label={roleLabel} />}
      <article className={`message ${message.role}`}>
        {roleLabel && <div className="message-role-badge">{roleLabel}</div>}
        {parts.length > 0 ? (
        <div className="message-flow">
          {collapsible && (
            <TurnProcessRow
              label={turnProcessLabel({ startedAt: run?.startedAt, completedAt: run?.completedAt, steps })}
              open={open}
              bodyId={processBodyId}
              // 收起时锚答案（注意力在答案上），展开时锚这一行（让过程向下长出来）。
              onToggle={(row) => onToggleProcess?.(message.id, !open, open ? answerRef.current : row)}
            />
          )}
          {collapsible ? (
            <>
              {/* 收起时只留「要人操作」的行与结果：过程行一律不渲染，展开才重建。 */}
              {open ? (
                <TurnProcessBody id={processBodyId}>
                  {run?.systemPrompt && <SystemContextBlock blockKey={`${namespace}-system-context`} prompt={run.systemPrompt} />}
                  {fold.process.map(renderPart)}
                </TurnProcessBody>
              ) : fold.pinned.map(renderPart)}
              {/* 结果区在两种状态下都渲染：它既是可见内容，也是滚动补偿的锚点。 */}
              <div className="turn-process-answer" ref={answerRef}>
                {fold.result.map(renderPart)}
                {text && <div className="message-content"><Markdown content={text} onOpenFile={onOpenFile} resolveOpenablePath={resolveOpenablePath} /></div>}
              </div>
            </>
          ) : (
            <>
              {run?.systemPrompt && <SystemContextBlock blockKey={`${namespace}-system-context`} prompt={run.systemPrompt} />}
              {parts.map(renderPart)}
              {text && <div className="message-content"><Markdown content={text} onOpenFile={onOpenFile} resolveOpenablePath={resolveOpenablePath} /></div>}
            </>
          )}
        </div>
      ) : traceItems.length > 0 && (
        <div className="trace-list">
          {traceItems.map((item) => (
            <TraceButton
              key={item.key}
              item={item}
              expanded={expandedToolIds.has(traceExpansionId(item))}
              onToggleTool={onToggleTool}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
      {!parts.length && text && <div className="message-content"><Markdown content={text} onOpenFile={onOpenFile} resolveOpenablePath={resolveOpenablePath} /></div>}
      {/* 成功轮次的状态由上面那行折叠加载；这里只服务不可折的成功轮次与失败/中断。 */}
      {statusLabel && !collapsible && <div className="message-run-status" role="status">{statusLabel}</div>}
      {canCopy && (
        <div className="message-user-actions">
          <CopyMessageButton copied={copied} copiedOk={copiedOk} onCopy={copyAssistant} />
        </div>
      )}
      </article>
    </>
  );
});

/** 合并时间线里的角色切换分隔线：谁接手了。 */
const RoleDivider = memo(function RoleDivider({ label }) {
  return (
    <div className="role-divider" role="separator">
      <span>{label ? `${label} 接手` : '切换角色'}</span>
    </div>
  );
});

/** 消息复制按钮：用户消息与助手消息共用，反馈图标取代原先的 ✓ / ✕ 文本字形。 */
const CopyMessageButton = memo(function CopyMessageButton({ copied, copiedOk, onCopy }) {
  const label = copied ? (copiedOk ? '已复制' : '复制失败') : '复制消息';
  return (
    <button type="button" data-tooltip={label} aria-label={label} onClick={onCopy}>
      {copied
        ? <span className={`copy-check${copiedOk ? '' : ' failed'}`} aria-hidden="true">{copiedOk ? <CheckIcon /> : <CloseIcon />}</span>
        : <CopyMessageIcon />}
    </button>
  );
});
