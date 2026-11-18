/**
 * Builds the single text blob that biod conditions on.
 *
 * Biod was trained on one user message, not on a chat transcript: feeding it the whole
 * microphone history would shift the distribution and cost latency. So the current user
 * message is the state, and the previous user message is only blended in when the current
 * one is too short to carry intent on its own ("continue", "do it", "yes please").
 */

const SHORT_STATE_CHARS = 40;
const PREVIOUS_MESSAGE_MAX_CHARS = 300;
const DEFAULT_MAX_CHARS = 2000;

export interface BiodStateInput {
  userMessage: string;
  messages?: Array<{ role: string; content: unknown }>;
  maxChars?: number;
}

export function buildBiodState(input: BiodStateInput): string {
  const current = String(input.userMessage ?? '').trim();
  if (!current) return '';

  const maxChars = positiveInteger(input.maxChars) ?? DEFAULT_MAX_CHARS;
  let state = current;
  if (current.length < SHORT_STATE_CHARS) {
    const previous = findPreviousUserMessage(input.messages, current);
    if (previous) {
      const clipped = previous.slice(0, PREVIOUS_MESSAGE_MAX_CHARS);
      state = `Previous: ${clipped}\nCurrent: ${current}`;
    }
  }
  return state.slice(0, maxChars);
}

/** The most recent *other* user message; a verbatim copy of the current one adds nothing. */
function findPreviousUserMessage(
  messages: Array<{ role: string; content: unknown }> | undefined,
  current: string,
): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || String(message.role ?? '') !== 'user') continue;
    const text = contentText(message.content);
    if (!text || text === current) continue;
    return text;
  }
  return undefined;
}

/** Message content is either a string or an array of parts; only text parts are state. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return String((part as { text: string }).text);
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return String((content as { text: string }).text).trim();
  }
  return '';
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
