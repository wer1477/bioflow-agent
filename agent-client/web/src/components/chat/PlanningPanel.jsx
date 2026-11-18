import { useState } from 'react';

/** Marker answer meaning "my answer is not one of the options". */
const CUSTOM_OPTION = '__custom__';

/**
 * The planning panel: a question card that gates the run, and the plan approval card.
 *
 * The question card is the only place where the fast path to a decision is a click, so it
 * is built around option chips rather than radios plus an always-visible text field: the
 * custom input appears only when the model's three options genuinely miss the answer.
 * Confirm stays disabled until every question has a usable answer, because a
 * half-answered batch sends the model an ambiguous instruction.
 */
export function PlanningPanel({ panel, onRespond }) {
  const [answers, setAnswers] = useState({});
  const [feedback, setFeedback] = useState('');
  const [submitted, setSubmitted] = useState(false);
  if (!panel || panel.status === 'complete') return null;

  if (panel.panel === 'clarify') {
    const questions = panel.questions || [];
    const answered = countAnswered(questions, answers);
    const confirm = () => {
      if (submitted) return;
      const rows = questions.map((question) => ({
        id: question.id,
        question: question.question,
        answer: String(answers[question.id] || '').trim(),
      }));
      onRespond?.(`规划询问面板已确认：\n${JSON.stringify({ type: 'planning_clarification_response', answers: rows }, null, 2)}`);
      setSubmitted(true);
    };
    return (
      <section className="planning-panel" data-planning-panel="clarify">
        <div className="planning-panel-heading">
          <h3>{panel.title || '需要确认的问题'}</h3>
          <span>{submitted ? '已提交' : `${answered}/${questions.length} 已回答`}</span>
        </div>
        <div className="planning-question-list">
          {questions.map((question) => {
            const value = answers[question.id] || '';
            const options = question.options || [];
            const isCustom = value !== '' && !options.includes(value);
            return (
              <div key={question.id} className="planning-question">
                <strong>{question.question}</strong>
                <div className="planning-option-chips" role="radiogroup" aria-label={question.question}>
                  {options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={value === option}
                      className={`planning-chip${value === option ? ' selected' : ''}`}
                      disabled={submitted}
                      onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}
                    >
                      {option}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isCustom}
                    className={`planning-chip${isCustom ? ' selected' : ''}`}
                    disabled={submitted}
                    onClick={() => setAnswers((current) => ({
                      ...current,
                      [question.id]: isCustom ? current[question.id] : CUSTOM_OPTION,
                    }))}
                  >
                    其他
                  </button>
                </div>
                {isCustom && (
                  <input
                    className="planning-custom-input"
                    value={value === CUSTOM_OPTION ? '' : value}
                    placeholder="输入你的答案"
                    aria-label={`${question.question} 的自定义答案`}
                    disabled={submitted}
                    autoFocus
                    onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className="planning-actions">
          <button
            className="primary-button"
            type="button"
            disabled={submitted || answered < questions.length}
            onClick={confirm}
          >
            {submitted ? '已提交' : '确认并继续'}
          </button>
        </div>
      </section>
    );
  }

  if (panel.panel === 'plan') {
    const approve = () => {
      onRespond?.(`我赞同这个 plan.md，请按计划开始执行。\n${JSON.stringify({ type: 'planning_plan_approved', filePath: panel.filePath || '' }, null, 2)}`);
    };
    const reject = () => {
      const text = feedback.trim();
      if (!text) return;
      onRespond?.(`我否认这个 plan.md，并提供修改意见：\n${text}\n${JSON.stringify({ type: 'planning_plan_rejected', filePath: panel.filePath || '', feedback: text }, null, 2)}`);
      setFeedback('');
    };
    return (
      <section className="planning-panel" data-planning-panel="plan">
        <div className="planning-panel-heading">
          <h3>{panel.title || '执行计划'}</h3>
          <span>{panel.filePath || 'planning/plan.md'}</span>
        </div>
        <pre className="planning-markdown">{panel.markdown || ''}</pre>
        <div className="planning-actions">
          <button className="primary-button" type="button" onClick={approve}>赞同并开始</button>
          <button className="secondary-button" type="button" onClick={() => setFeedback((value) => value || ' ')}>否认</button>
        </div>
        {feedback !== '' && (
          <textarea
            className="planning-feedback"
            rows="3"
            value={feedback === ' ' ? '' : feedback}
            placeholder="输入修改意见，按 Enter 提交"
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                reject();
              }
            }}
          />
        )}
      </section>
    );
  }

  return null;
}

/** How many questions carry a usable answer (a bare "custom" marker does not count). */
function countAnswered(questions, answers) {
  return questions.reduce((total, question) => {
    const value = String(answers[question.id] || '').trim();
    return value && value !== CUSTOM_OPTION ? total + 1 : total;
  }, 0);
}
