import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_RENDER_PAGES,
  MAX_PDF_TEXT_CHARS,
  detectImageMime,
  imageDimensions,
  readImageFilePayload,
  readMediaFile,
} from '../src/agent/core_tools/read_media.js';

// 70-byte 1x1 opaque PNG (fixed bytes so the fixture cannot drift).
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let tempRoot = '';

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'bioflow-media-'));
});

after(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

function writeFixture(name: string, content: Buffer | string): Promise<string> {
  const target = path.join(tempRoot, name);
  return writeFile(target, content).then(() => target);
}

function fakePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function fakeJpeg(width: number, height: number): Buffer {
  // SOI + APP0 (JFIF) + SOF0 carrying the frame size + EOI.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof0 = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]);
}

function fakeGif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'latin1');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function fakeWebpVp8x(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8X', 12, 'latin1');
  buffer.writeUInt32LE(10, 16);
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  buffer[24] = widthMinusOne & 0xff;
  buffer[25] = (widthMinusOne >> 8) & 0xff;
  buffer[26] = (widthMinusOne >> 16) & 0xff;
  buffer[27] = heightMinusOne & 0xff;
  buffer[28] = (heightMinusOne >> 8) & 0xff;
  buffer[29] = (heightMinusOne >> 16) & 0xff;
  return buffer;
}

function fakeBmp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(54);
  buffer.write('BM', 0, 'latin1');
  buffer.writeUInt32LE(54, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(-height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  return buffer;
}

/**
 * Minimal PDF generator: one page per string array, one text line per entry.
 * Built by hand so the test does not depend on a PDF library.
 */
function buildPdf(pageLines: string[][]): Buffer {
  const pageCount = pageLines.length;
  const objects: string[] = [];
  const kids: string[] = [];
  for (let index = 0; index < pageCount; index += 1) kids.push(`${4 + index * 2} 0 R`);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const parts = ['BT', '/F1 9 Tf', '20 760 Td'];
    for (const line of pageLines[index]) {
      parts.push(`(${line}) Tj`);
      parts.push('0 -10 Td');
    }
    parts.push('ET');
    const stream = parts.join('\n');
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  const maxId = 3 + pageCount * 2;
  let output = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = Buffer.byteLength(output);
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(output);
  output += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(output, 'latin1');
}

function buildTextPdf(pageTexts: string[]): Buffer {
  return buildPdf(pageTexts.map((text) => [text]));
}

test('detectImageMime recognizes the supported containers and rejects everything else', () => {
  assert.equal(detectImageMime(fakePng(1, 1)), 'image/png');
  assert.equal(detectImageMime(fakeJpeg(10, 20)), 'image/jpeg');
  assert.equal(detectImageMime(fakeGif(320, 200)), 'image/gif');
  assert.equal(detectImageMime(fakeWebpVp8x(100, 50)), 'image/webp');
  assert.equal(detectImageMime(fakeBmp(10, 20)), 'image/bmp');

  assert.equal(detectImageMime(Buffer.alloc(0)), null);
  assert.equal(detectImageMime(Buffer.from('plain text, not an image')), null);
  assert.equal(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  // "BM" alone is only two bytes and must not be mistaken for a bitmap.
  assert.equal(detectImageMime(Buffer.from('BM')), null);
});

test('imageDimensions reads headers without decoding the pixel data', () => {
  assert.deepEqual(imageDimensions(fakePng(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageDimensions(fakeJpeg(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(imageDimensions(fakeGif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageDimensions(fakeWebpVp8x(100, 50)), { width: 100, height: 50 });
  assert.deepEqual(imageDimensions(fakeBmp(10, 20)), { width: 10, height: 20 });
  assert.deepEqual(imageDimensions(ONE_PIXEL_PNG), { width: 1, height: 1 });

  assert.equal(imageDimensions(Buffer.from('not an image')), null);
  assert.equal(imageDimensions(fakePng(640, 480).subarray(0, 20)), null);
});

test('readMediaFile returns base64 image data without a data URL prefix', async () => {
  const target = await writeFixture('pixel.png', ONE_PIXEL_PNG);
  const result = await readMediaFile(target);

  assert.ok(result);
  assert.equal(result.kind, 'image');
  if (result.kind !== 'image') return;
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.size, ONE_PIXEL_PNG.length);
  assert.equal(result.image.mimeType, 'image/png');
  assert.equal(result.image.data, ONE_PIXEL_PNG.toString('base64'));
  assert.equal(result.image.data.startsWith('data:'), false);
  assert.equal(result.image.label, 'pixel.png');
});

test('readImageFilePayload returns null for missing, non-image and oversized files', async () => {
  const imagePath = await writeFixture('tiny.png', ONE_PIXEL_PNG);
  const payload = await readImageFilePayload(imagePath);
  assert.ok(payload);
  assert.equal(payload?.mimeType, 'image/png');
  assert.equal(payload?.data, ONE_PIXEL_PNG.toString('base64'));
  assert.equal(payload?.label, 'tiny.png');

  const textPath = await writeFixture('notes.txt', 'not an image');
  assert.equal(await readImageFilePayload(textPath), null);
  assert.equal(await readImageFilePayload(path.join(tempRoot, 'missing.png')), null);

  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  ONE_PIXEL_PNG.copy(oversized, 0);
  const oversizedPath = await writeFixture('oversized.png', oversized);
  assert.equal(await readImageFilePayload(oversizedPath), null);
});

test('readMediaFile returns null for non-media files', async () => {
  const textPath = await writeFixture('readme.md', '# hello\n');
  assert.equal(await readMediaFile(textPath), null);
  const emptyPath = await writeFixture('empty.bin', '');
  assert.equal(await readMediaFile(emptyPath), null);
  const directoryPath = path.join(tempRoot, 'a-directory');
  await mkdir(directoryPath, { recursive: true });
  assert.equal(await readMediaFile(directoryPath), null);
});

test('readMediaFile rejects images larger than the media budget', async () => {
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  ONE_PIXEL_PNG.copy(oversized, 0);
  const oversizedPath = await writeFixture('too-big.png', oversized);
  await assert.rejects(readMediaFile(oversizedPath), /8\.0 MiB/);
});

test('readMediaFile extracts PDF text, page count and rasterized pages', async () => {
  const pdf = buildPdf([
    ['page one alpha beta', 'second line on page one'],
    ['page two gamma delta'],
  ]);
  const target = await writeFixture('two-pages.pdf', pdf);
  const result = await readMediaFile(target);

  assert.ok(result);
  assert.equal(result?.kind, 'pdf');
  if (!result || result.kind !== 'pdf') return;
  assert.equal(result.size, pdf.length);
  assert.equal(result.pageCount, 2);
  assert.equal(result.truncated, false);
  assert.match(result.text, /page one alpha beta/);
  assert.match(result.text, /page two gamma delta/);
  assert.match(result.text, /-- page 1 of 2 --/);
  assert.deepEqual(result.pages, [1, 2]);

  if (result.images.length > 0) {
    // Canvas available: pages render to PNG data URLs without the prefix.
    assert.equal(result.images.length, 2);
    for (const [index, image] of result.images.entries()) {
      assert.equal(image.mimeType, 'image/png');
      assert.equal(image.label, `page ${index + 1}`);
      assert.equal(image.data.startsWith('data:'), false);
      const bytes = Buffer.from(image.data, 'base64');
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  } else {
    // Canvas unavailable (e.g. no @napi-rs/canvas binary): text survives and the
    // render failure is reported as a warning instead of throwing.
    assert.ok(result.warnings.some((warning) => /render/i.test(warning)));
    assert.deepEqual(result.warnings.length > 0, true);
  }
});

test('readMediaFile renders at most three pages by default and honors the pages option', async () => {
  const pdf = buildTextPdf(['one', 'two', 'three', 'four', 'five']);
  const target = await writeFixture('five-pages.pdf', pdf);

  const defaultResult = await readMediaFile(target);
  assert.ok(defaultResult && defaultResult.kind === 'pdf');
  if (!defaultResult || defaultResult.kind !== 'pdf') return;
  assert.equal(defaultResult.pageCount, 5);
  assert.deepEqual(defaultResult.pages, [1, 2, 3]);
  if (defaultResult.images.length > 0) {
    assert.equal(defaultResult.images.length, MAX_PDF_RENDER_PAGES);
    assert.equal(defaultResult.images.length, defaultResult.pages.length);
  }

  const secondPage = await readMediaFile(target, { pages: '2' });
  assert.ok(secondPage && secondPage.kind === 'pdf');
  if (!secondPage || secondPage.kind !== 'pdf') return;
  assert.deepEqual(secondPage.pages, [2]);
  if (secondPage.images.length > 0) {
    assert.equal(secondPage.images.length, 1);
    assert.equal(secondPage.images[0].label, 'page 2');
  }
  assert.match(secondPage.text, /two/);

  const outOfRange = await readMediaFile(target, { pages: '99' });
  assert.ok(outOfRange && outOfRange.kind === 'pdf');
  if (!outOfRange || outOfRange.kind !== 'pdf') return;
  assert.deepEqual(outOfRange.pages, [1, 2, 3]);
  assert.ok(outOfRange.warnings.some((warning) => /pages="99"/.test(warning)));
});

test('readMediaFile truncates long PDF text to the model budget', async () => {
  const line = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const pageLines = Array.from({ length: 20 }, (_, page) => Array.from({ length: 70 }, (_, lineNumber) => `p${page + 1} l${lineNumber + 1} ${line}`));
  const target = await writeFixture('long.pdf', buildPdf(pageLines));

  const result = await readMediaFile(target);
  assert.ok(result && result.kind === 'pdf');
  if (!result || result.kind !== 'pdf') return;
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, MAX_PDF_TEXT_CHARS);
  assert.equal(result.pageCount, 20);
  assert.deepEqual(result.pages, [1, 2, 3]);
});

test('readMediaFile degrades a corrupt PDF to warnings instead of throwing', async () => {
  const target = await writeFixture('corrupt.pdf', '%PDF-1.4\nthis is definitely not a real pdf\n%%EOF\n');
  const result = await readMediaFile(target);

  assert.ok(result);
  assert.equal(result?.kind, 'pdf');
  if (!result || result.kind !== 'pdf') return;
  assert.equal(result.pageCount, 0);
  assert.equal(result.text, '');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.images, []);
  assert.ok(result.warnings.length > 0);
});

test('readMediaFile keeps the raw PDF bytes available to the caller', async () => {
  const pdf = buildTextPdf(['sanity']);
  const target = await writeFixture('sanity.pdf', pdf);
  const result = await readMediaFile(target);
  assert.equal(result?.kind, 'pdf');
  if (!result || result.kind !== 'pdf') return;
  assert.equal(result.size, (await readFile(target)).length);
});
