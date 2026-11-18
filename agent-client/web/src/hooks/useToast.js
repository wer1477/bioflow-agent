import { useCallback, useMemo, useRef, useState } from 'react';

let toastCounter = 0;

export function useToast() {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const removeToast = useCallback((id) => {
    setToasts((rows) => rows.filter((item) => item.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback((message, type = 'info', options = {}) => {
    toastCounter += 1;
    const id = options.id || `toast-${Date.now()}-${toastCounter}`;
    setToasts((rows) => [...rows, { id, message, type }]);
    const duration = options.duration ?? 3500;
    if (duration !== 0) {
      const timer = setTimeout(() => removeToast(id), duration);
      timersRef.current.set(id, timer);
    }
    return id;
  }, [removeToast]);

  const toast = useMemo(() => ({
    success: (message, options) => show(message, 'success', options),
    error: (message, options) => show(message, 'error', options),
    info: (message, options) => show(message, 'info', options),
  }), [show]);

  return { toasts, toast, removeToast };
}
