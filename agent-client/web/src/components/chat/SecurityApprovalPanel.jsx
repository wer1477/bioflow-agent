import { useState } from 'react';

export function SecurityApprovalPanel({ request, onRespond }) {
  const [decision, setDecision] = useState('');
  const [error, setError] = useState('');
  const effectiveDecision = decision || request.decision || '';
  const respond = async (nextDecision) => {
    if (effectiveDecision) return;
    setError('');
    try {
      await onRespond?.(request, nextDecision);
      setDecision(nextDecision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <section className="planning-panel security-approval-panel">
      <div className="planning-panel-heading">
        <h3>安全审批：{request.toolName}</h3>
        <span>{request.mode} · {String(request.risk || '').replace(/_/g, ' ')}</span>
      </div>
      <p>{request.reason}</p>
      <pre className="planning-markdown">{JSON.stringify(request.arguments || {}, null, 2)}</pre>
      {effectiveDecision ? (
        <p>{effectiveDecision === 'approve' ? '已批准，正在执行。' : '已拒绝，Agent 已收到拒绝结果。'}</p>
      ) : (
        <div className="planning-actions">
          <button className="primary-button" type="button" onClick={() => respond('approve')}>批准一次</button>
          <button className="danger-button" type="button" onClick={() => respond('deny')}>拒绝</button>
        </div>
      )}
      {error && <p className="hint">{error}</p>}
    </section>
  );
}
