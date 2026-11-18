import { CloseIcon } from './icons.jsx';

export function ToastViewport({ toasts, onClose }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-viewport" aria-live="polite" aria-label="通知">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>
          <span>{toast.message}</span>
          <button className="toast-close" type="button" data-tooltip="关闭" aria-label="关闭通知" onClick={() => onClose(toast.id)}><CloseIcon /></button>
        </div>
      ))}
    </div>
  );
}
