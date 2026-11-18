import type { ToolImage } from './read_media.js';

/**
 * Transport of images that appear inside CoreTool result JSON.
 *
 * Tool results are strings: the runtime stores them in observations/transcripts
 * and shows them to the UI. Base64 image data has no business being in those
 * strings, so it is lifted out here and re-attached to the *model* message as
 * `image_url` content parts (see `buildToolMessageContent`).
 *
 * This module is deliberately provider-agnostic and side-effect free; the LLM
 * client decides whether the current model accepts image parts.
 */

export interface ToolResultImages { text: string; images: ToolImage[]; warnings: string[] }

/** At most this many images are attached to a single tool result. */
export const MAX_TOOL_RESULT_IMAGES = 4;
/** Per-image decoded size limit for tool-result images (6 MiB). */
export const MAX_TOOL_RESULT_IMAGE_BYTES = 6 * 1024 * 1024;
/** Total decoded image budget for a single tool result (12 MiB). */
export const MAX_TOOL_RESULT_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;

const IMAGE_OMITTED_TEXT = '[image omitted: the model does not accept image input]';
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9][a-z0-9.+-]*$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Pull `images` / `image` out of a tool-result JSON string.
 *
 * Returns the result text with those fields removed (so base64 never reaches
 * observations, transcripts, event previews or the model as text) plus the
 * images that fit the size/count budget. Non-JSON results and results without
 * image fields are returned verbatim.
 */
export function extractToolResultImages(result: string): ToolResultImages {
  if (typeof result !== 'string' || !result.trim()) return { text: result, images: [], warnings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return { text: result, images: [], warnings: [] };
  }
  if (!isRecord(parsed)) return { text: result, images: [], warnings: [] };

  const record = parsed;
  const imagesValue = record.images;
  const imageValue = record.image;
  // Only treat the fields as image payloads when they look like one: a tool
  // result may legitimately carry `{"image":"plot.png"}` as a plain path, and
  // dropping that would be worse than leaving it alone.
  const imagesArePayload = Object.hasOwn(record, 'images')
    && (Array.isArray(imagesValue) || looksLikeImagePayload(imagesValue));
  const imageIsPayload = Object.hasOwn(record, 'image')
    && (Array.isArray(imageValue) || looksLikeImagePayload(imageValue));
  if (!imagesArePayload && !imageIsPayload) return { text: result, images: [], warnings: [] };

  const candidates: unknown[] = [];
  if (imagesArePayload) candidates.push(...asImageCandidates(imagesValue));
  if (imageIsPayload) candidates.push(...asImageCandidates(imageValue));
  // Always drop the image fields, even when every candidate is invalid: a
  // malformed image payload must not leak its base64 into the result text.
  delete record.images;
  delete record.image;
  const text = JSON.stringify(record);

  const images: ToolImage[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  let droppedForCount = 0;

  for (const [index, candidate] of candidates.entries()) {
    const image = normalizeImageCandidate(candidate);
    if (!image) {
      warnings.push(`Dropped an invalid image entry at index ${index}: expected an image/* mime type and base64 data.`);
      continue;
    }
    const byteSize = base64ByteLength(image.data);
    if (byteSize > MAX_TOOL_RESULT_IMAGE_BYTES) {
      warnings.push(`Dropped image ${index + 1} (${image.mimeType}): ${formatMegabytes(byteSize)} exceeds the ${formatMegabytes(MAX_TOOL_RESULT_IMAGE_BYTES)} per-image limit.`);
      continue;
    }
    if (images.length >= MAX_TOOL_RESULT_IMAGES) {
      droppedForCount += 1;
      continue;
    }
    if (totalBytes + byteSize > MAX_TOOL_RESULT_IMAGE_TOTAL_BYTES) {
      warnings.push(`Dropped image ${index + 1} (${image.mimeType}): the ${formatMegabytes(MAX_TOOL_RESULT_IMAGE_TOTAL_BYTES)} total image limit for one tool result was reached.`);
      continue;
    }
    totalBytes += byteSize;
    images.push(image);
  }
  if (droppedForCount) {
    warnings.push(`Dropped ${droppedForCount} image(s): at most ${MAX_TOOL_RESULT_IMAGES} images are attached to one tool result.`);
  }

  return { text, images, warnings };
}

/**
 * Build the model-visible tool message content. Without images this is the
 * original text (keeping the common path unchanged); with images the text comes
 * first and is followed by one `image_url` part per image.
 */
export function buildToolMessageContent(text: string, images: ToolImage[]): string | Array<Record<string, unknown>> {
  const attachable = (Array.isArray(images) ? images : [])
    .filter((image): image is ToolImage => isRecord(image)
      && typeof image.data === 'string' && image.data.length > 0
      && typeof image.mimeType === 'string' && IMAGE_MIME_PATTERN.test(image.mimeType))
    .slice(0, MAX_TOOL_RESULT_IMAGES);
  if (!attachable.length) return text;
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text }];
  for (const image of attachable) {
    parts.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
  }
  return parts;
}

/**
 * Text-only fallback for models that reject image input: every `image_url`
 * content part becomes a short text placeholder. Message objects and their
 * other content parts are shared by reference; the original array is not
 * mutated, so a retry can still send the full payload.
 */
export function sanitizeMessagesForTextOnly<T>(messages: T[]): T[] {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!isRecord(message)) return message;
    const content = message.content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const nextContent = content.map((part) => {
      if (!isRecord(part)) return part;
      if (part.type !== 'image_url' && !Object.hasOwn(part, 'image_url')) return part;
      changed = true;
      return { type: 'text', text: IMAGE_OMITTED_TEXT };
    });
    if (!changed) return message;
    return { ...message, content: nextContent } as unknown as T;
  });
}

function asImageCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function looksLikeImagePayload(value: unknown): boolean {
  return isRecord(value) && (typeof value.data === 'string' || typeof value.mimeType === 'string');
}

/** Accept raw base64 as well as `data:<mime>;base64,<payload>` (MCP tools use both). */
function normalizeImageCandidate(candidate: unknown): ToolImage | null {
  if (!isRecord(candidate)) return null;
  let mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType.trim().toLowerCase() : '';
  let data = typeof candidate.data === 'string' ? candidate.data : '';

  if (data.startsWith('data:')) {
    const dataUrl = /^data:([^;,]*)(?:;base64)?,([\s\S]*)$/i.exec(data);
    if (!dataUrl) return null;
    if (!mimeType && dataUrl[1]) mimeType = dataUrl[1].trim().toLowerCase();
    data = dataUrl[2];
  }
  data = data.replace(/\s+/g, '');
  if (!IMAGE_MIME_PATTERN.test(mimeType)) return null;
  if (!data || data.length % 4 === 1 || !BASE64_PATTERN.test(data)) return null;
  if (data.length % 4 === 2) data += '==';
  else if (data.length % 4 === 3) data += '=';
  const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : undefined;
  return { mimeType, data, ...(label ? { label } : {}) };
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coarse token estimate for one attached image. Providers bill image inputs by
 * resolution; 1,024 tokens is a deliberately conservative middle ground that keeps
 * the context-budget heuristic from treating a base64 data URL as text.
 */
export const IMAGE_TOKEN_ESTIMATE = 1024;

/** Number of `image_url` content parts across all messages. */
export function countMessageImages<T>(messages: T[]): number {
  let count = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isRecord(part) && (part.type === 'image_url' || Object.hasOwn(part, 'image_url'))) count += 1;
    }
  }
  return count;
}

/**
 * Replace image content parts with a short text placeholder. Used for contexts
 * that must stay text-only and bounded: token estimation, transcript storage and
 * the compaction summarizer (a base64 data URL there would dwarf the real prompt).
 */
export function stripImageParts<T>(messages: T[], placeholder = '[image omitted]'): T[] {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (!isRecord(part)) return part;
      if (part.type !== 'image_url' && !Object.hasOwn(part, 'image_url')) return part;
      changed = true;
      const mimeType = isRecord(part.image_url) && typeof (part.image_url as Record<string, unknown>).url === 'string'
        ? dataUrlMimeType(String((part.image_url as Record<string, unknown>).url))
        : '';
      return { type: 'text', text: mimeType ? `${placeholder} (${mimeType})` : placeholder };
    });
    return changed ? ({ ...message, content } as unknown as T) : message;
  });
}

function dataUrlMimeType(url: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(url);
  return match?.[1] ?? '';
}
