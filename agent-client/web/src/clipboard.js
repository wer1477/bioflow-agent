// 剪贴板写入：优先 Clipboard API（需安全上下文），失败时降级到 execCommand。
// 非安全上下文（http + 非 localhost）下 navigator.clipboard 为 undefined，
// 若只依赖它会导致静默无操作。

export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // 权限被拒等，降级到旧方法
      console.warn('Clipboard API failed, falling back to execCommand', err);
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    console.warn('execCommand copy failed', err);
    ok = false;
  }
  document.body.removeChild(textarea);
  if (!ok) console.warn('copyToClipboard: all methods failed');
  return ok;
}
