import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TOOL_RESULT_IMAGES,
  MAX_TOOL_RESULT_IMAGE_BYTES,
  MAX_TOOL_RESULT_IMAGE_TOTAL_BYTES,
  buildToolMessageContent,
  extractToolResultImages,
  sanitizeMessagesForTextOnly,
} from '../src/agent/core_tools/image_payload.js';
import type { ToolImage } from '../src/agent/core_tools/read_media.js';

const IMAGE_OMITTED_TEXT = '[image omitted: the model does not accept image input]';

function base64Of(byteCount: number, fill = 1): string {
  return Buffer.alloc(byteCount, fill).toString('base64');
}

function pngPayload(byteCount = 16): ToolImage {
  return { mimeType: 'image/png', data: base64Of(byteCount) };
}

test('non-JSON tool results pass through untouched', () => {
  const raw = 'plain text result, not JSON';
  assert.deepEqual(extractToolResultImages(raw), { text: raw, images: [], warnings: [] });
  assert.deepEqual(extractToolResultImages(''), { text: '', images: [], warnings: [] });
  assert.deepEqual(extractToolResultImages('{"ok":false,'), { text: '{"ok":false,', images: [], warnings: [] });
});

test('JSON tool results without image fields keep their original formatting', () => {
  const raw = '{"ok":true, "path":"/tmp/x.png", "size":70}';
  const extracted = extractToolResultImages(raw);
  assert.deepEqual(extracted.images, []);
  assert.deepEqual(extracted.warnings, []);
  assert.equal(extracted.text, raw);
});

test('an image field that is not an image payload is left in the result text', () => {
  const pathOnly = JSON.stringify({ ok: true, image: 'plots/figure1.png' });
  const pathExtracted = extractToolResultImages(pathOnly);
  assert.deepEqual(pathExtracted.images, []);
  assert.deepEqual(pathExtracted.warnings, []);
  assert.equal(pathExtracted.text, pathOnly);

  const urlOnly = JSON.stringify({ ok: true, image: { url: 'https://example.test/a.png' } });
  assert.equal(extractToolResultImages(urlOnly).text, urlOnly);
});

test('a single image field is lifted out of the result text', () => {
  const raw = JSON.stringify({
    ok: true,
    path: '/tmp/plot.png',
    image: { mimeType: 'image/png', data: base64Of(32), label: 'plot.png' },
  });
  const extracted = extractToolResultImages(raw);
  assert.equal(extracted.images.length, 1);
  assert.equal(extracted.images[0].mimeType, 'image/png');
  assert.equal(extracted.images[0].data, base64Of(32));
  assert.equal(extracted.images[0].label, 'plot.png');
  assert.equal(extracted.text.includes('image'), false);
  const parsed = JSON.parse(extracted.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.path, '/tmp/plot.png');
  assert.equal('image' in parsed, false);
});

test('an images array is lifted out and every base64 byte is removed from the text', () => {
  const raw = JSON.stringify({
    ok: true,
    page_count: 2,
    images: [
      { mimeType: 'image/png', data: base64Of(24), label: 'page 1' },
      { mimeType: 'image/jpeg', data: base64Of(12, 2), label: 'page 2' },
    ],
    warnings: [],
  });
  const extracted = extractToolResultImages(raw);
  assert.equal(extracted.images.length, 2);
  assert.deepEqual(extracted.images.map((image) => image.mimeType), ['image/png', 'image/jpeg']);
  assert.deepEqual(extracted.images.map((image) => image.label), ['page 1', 'page 2']);
  const parsed = JSON.parse(extracted.text);
  assert.equal('images' in parsed, false);
  assert.equal(extracted.text.includes(base64Of(24)), false);
  assert.equal(parsed.page_count, 2);
  assert.deepEqual(parsed.warnings, []);
});

test('data URL image payloads are normalized to raw base64', () => {
  const raw = JSON.stringify({
    ok: true,
    image: { data: `data:image/webp;base64,${base64Of(20)}` },
  });
  const extracted = extractToolResultImages(raw);
  assert.equal(extracted.images.length, 1);
  assert.equal(extracted.images[0].mimeType, 'image/webp');
  assert.equal(extracted.images[0].data, base64Of(20));
});

test('invalid image entries are dropped, removed from the text and reported', () => {
  const raw = JSON.stringify({
    ok: true,
    images: [
      { mimeType: 'text/plain', data: base64Of(16) },
      { mimeType: 'image/png', data: 'not base64 !!!' },
      { mimeType: 'image/png', data: 'a' },
      { data: base64Of(16) },
      { mimeType: 'image/png', data: base64Of(16) },
    ],
  });
  const extracted = extractToolResultImages(raw);
  assert.equal(extracted.images.length, 1);
  assert.equal(extracted.text.includes('images'), false);
  assert.equal(extracted.text.includes(base64Of(16)), false);
  assert.ok(extracted.warnings.length >= 3);
  assert.ok(extracted.warnings.every((warning) => /invalid/i.test(warning)));
});

test('images beyond the count budget are dropped with a warning', () => {
  const images = Array.from({ length: MAX_TOOL_RESULT_IMAGES + 2 }, () => ({ mimeType: 'image/png', data: base64Of(8) }));
  const extracted = extractToolResultImages(JSON.stringify({ ok: true, images }));
  assert.equal(extracted.images.length, MAX_TOOL_RESULT_IMAGES);
  assert.ok(extracted.warnings.some((warning) => warning.includes(`at most ${MAX_TOOL_RESULT_IMAGES} images`)));
});

test('images above the per-image budget are dropped and the rest are kept', () => {
  const oversized = { mimeType: 'image/png', data: base64Of(MAX_TOOL_RESULT_IMAGE_BYTES + 1) };
  const extracted = extractToolResultImages(JSON.stringify({ ok: true, images: [oversized, pngPayload()] }));
  assert.equal(extracted.images.length, 1);
  assert.equal(extracted.images[0].data, base64Of(16));
  assert.ok(extracted.warnings.some((warning) => /per-image limit/.test(warning)));
  assert.equal(extracted.text.includes(oversized.data), false);
});

test('the total image budget stops attachments once it is exhausted', () => {
  const perImageBytes = 4 * 1024 * 1024;
  assert.ok(perImageBytes * 3 <= MAX_TOOL_RESULT_IMAGE_TOTAL_BYTES);
  assert.ok(perImageBytes * 4 > MAX_TOOL_RESULT_IMAGE_TOTAL_BYTES);
  const images = Array.from({ length: 4 }, (_, index) => ({ mimeType: 'image/png', data: base64Of(perImageBytes, index + 1) }));
  const extracted = extractToolResultImages(JSON.stringify({ ok: true, images }));

  assert.equal(extracted.images.length, 3);
  assert.ok(extracted.warnings.some((warning) => /total image limit/.test(warning)));
  assert.equal(extracted.text.includes(images[0].data), false);
});

test('buildToolMessageContent keeps text-only results as a string', () => {
  assert.equal(buildToolMessageContent('tool result text', []), 'tool result text');
  assert.equal(buildToolMessageContent('tool result text', [{ mimeType: 'text/plain', data: 'AAAA' } as ToolImage]), 'tool result text');
});

test('buildToolMessageContent emits text first, then image_url data URLs', () => {
  const content = buildToolMessageContent('two charts attached', [pngPayload(8), { mimeType: 'image/jpeg', data: base64Of(8, 2) }]);
  assert.ok(Array.isArray(content));
  if (!Array.isArray(content)) return;
  assert.equal(content.length, 3);
  assert.deepEqual(content[0], { type: 'text', text: 'two charts attached' });
  assert.deepEqual(content[1], {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${base64Of(8)}` },
  });
  assert.deepEqual(content[2], {
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${base64Of(8, 2)}` },
  });
});

test('sanitizeMessagesForTextOnly replaces image parts without mutating the input', () => {
  const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'look at this' }, imagePart] },
    { role: 'assistant', content: 'plain string content' },
    { role: 'tool', tool_call_id: 'call-1', content: [{ type: 'text', text: 'tool result' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' }, detail: 'low' }] },
    { role: 'user', content: [{ type: 'text', text: 'no images here' }] },
  ];

  const sanitized = sanitizeMessagesForTextOnly(messages);

  assert.notEqual(sanitized, messages);
  assert.deepEqual((sanitized[0] as any).content, [
    { type: 'text', text: 'look at this' },
    { type: 'text', text: IMAGE_OMITTED_TEXT },
  ]);
  assert.equal((sanitized[1] as any).content, 'plain string content');
  assert.deepEqual((sanitized[2] as any).content, [
    { type: 'text', text: 'tool result' },
    { type: 'text', text: IMAGE_OMITTED_TEXT },
  ]);
  assert.deepEqual((sanitized[3] as any).content, [{ type: 'text', text: 'no images here' }]);

  // The original payload is untouched so the client can retry with images.
  assert.equal((messages[0] as any).content[1], imagePart);
  assert.equal((messages[0] as any).content[1].type, 'image_url');
  assert.equal((messages[2] as any).content[1].type, 'image_url');
});

test('sanitizeMessagesForTextOnly tolerates messages without array content', () => {
  const messages = [{ role: 'system', content: 'rules' }, {}, { role: 'user' }];
  assert.deepEqual(sanitizeMessagesForTextOnly(messages as any[]), messages);
  assert.deepEqual(sanitizeMessagesForTextOnly([]), []);
});
