export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export function formatCompactTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatTokenCount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number >= 1_000_000) return `${trimNumber(number / 1_000_000)}M`;
  if (number >= 1_000) return `${trimNumber(number / 1_000)}k`;
  return String(Math.round(number));
}

function trimNumber(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}
