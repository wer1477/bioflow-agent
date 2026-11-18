import fs from 'node:fs';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';

/**
 * Multimodal media reading for the file tools.
 *
 * The module turns an image or PDF file into the payloads a model can consume:
 * - images are returned as raw base64 (`ToolImage.data`, no `data:` prefix);
 * - PDFs are returned as extracted text plus (best effort) page screenshots.
 *
 * It deliberately never throws for *content* problems (encrypted/broken PDF,
 * missing font for rendering, ...): those degrade to `warnings` so the caller can
 * still hand the model the text it did manage to read. I/O errors and oversized
 * images are real errors and are surfaced to the tool executor.
 */

export interface ToolImage { mimeType: string; data: string; label?: string }

export interface MediaReadResultImage {
  kind: 'image';
  mimeType: string;
  size: number;
  image: ToolImage;
}

export interface MediaReadResultPdf {
  kind: 'pdf';
  size: number;
  pageCount: number;
  /** Page numbers that were rendered (or requested when rendering failed). */
  pages: number[];
  text: string;
  truncated: boolean;
  images: ToolImage[];
  warnings: string[];
}

export type MediaReadResult = MediaReadResultImage | MediaReadResultPdf;

/** Largest image the file tools will inline as base64 (8 MiB). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Largest PDF text handed back to the model (characters). */
export const MAX_PDF_TEXT_CHARS = 50_000;
/** At most this many PDF pages are rasterized per read. */
export const MAX_PDF_RENDER_PAGES = 3;
/** Scale used when rasterizing pages for the model. */
export const PDF_RENDER_SCALE = 1.2;

const IMAGE_MIME_PNG = 'image/png';
const IMAGE_MIME_JPEG = 'image/jpeg';
const IMAGE_MIME_GIF = 'image/gif';
const IMAGE_MIME_WEBP = 'image/webp';
const IMAGE_MIME_BMP = 'image/bmp';

/**
 * pdf-parse substitutes `page_number` / `total_number` placeholders in the
 * page joiner. The contract asked for a human-readable `-- page N of M --`
 * marker, which these placeholders produce after substitution.
 */
const PDF_PAGE_JOINER = '\n-- page page_number of total_number --\n';
const PDF_HEADER_SAMPLE_BYTES = 32;
const MAX_WARNING_DETAIL_CHARS = 300;

/**
 * Detect a supported raster image container from its magic bytes.
 * Returns `null` for anything unsupported (including SVG, which is text and
 * must never be treated as an image payload).
 */
export function detectImageMime(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) return null;
  if (
    buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return IMAGE_MIME_PNG;
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return IMAGE_MIME_JPEG;
  }
  if (buffer.length >= 6) {
    const gifHeader = buffer.toString('latin1', 0, 6);
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return IMAGE_MIME_GIF;
  }
  if (
    buffer.length >= 12
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return IMAGE_MIME_WEBP;
  }
  // A "BM" prefix is only two bytes; require the full 14-byte bitmap file
  // header so ordinary text files that happen to start with BM are not inlined.
  if (buffer.length >= 14 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return IMAGE_MIME_BMP;
  }
  return null;
}

/**
 * Best-effort pixel dimensions for the supported image formats.
 * Returns `null` when the header is incomplete or does not carry dimensions we
 * understand; it never throws.
 */
export function imageDimensions(buffer: Buffer): { width: number; height: number } | null {
  try {
    const mimeType = detectImageMime(buffer);
    switch (mimeType) {
      case IMAGE_MIME_PNG: return pngDimensions(buffer);
      case IMAGE_MIME_JPEG: return jpegDimensions(buffer);
      case IMAGE_MIME_GIF: return gifDimensions(buffer);
      case IMAGE_MIME_WEBP: return webpDimensions(buffer);
      case IMAGE_MIME_BMP: return bmpDimensions(buffer);
      default: return null;
    }
  } catch {
    return null;
  }
}

/**
 * Read a single image file as a model payload. Returns `null` (never throws) so
 * callers that treat images as optional (Python figure promotion) can ignore it.
 */
export async function readImageFilePayload(absPath: string): Promise<ToolImage | null> {
  try {
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) return null;
    const buffer = await fs.promises.readFile(absPath);
    const mimeType = detectImageMime(buffer);
    if (!mimeType) return null;
    return { mimeType, data: buffer.toString('base64'), label: path.basename(absPath) };
  } catch {
    return null;
  }
}

/**
 * Resolve an image or PDF file into a model payload.
 *
 * - image → `{ kind:'image', ... }`, base64 has no `data:` prefix;
 * - PDF → `{ kind:'pdf', ... }`, text capped at `MAX_PDF_TEXT_CHARS` and up to
 *   `MAX_PDF_RENDER_PAGES` page screenshots (render failures degrade to warnings);
 * - anything else → `null` (the caller falls back to its text path).
 *
 * Oversized images throw: the caller cannot honor the request, and silently
 * returning `null` would make the file tool try to decode binary bytes as text.
 */
export async function readMediaFile(absPath: string, options: { pages?: string } = {}): Promise<MediaReadResult | null> {
  const stat = await fs.promises.stat(absPath);
  if (!stat.isFile()) return null;

  const header = await readHeaderSample(absPath, PDF_HEADER_SAMPLE_BYTES);
  const mimeType = detectImageMime(header);
  if (mimeType) {
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image file ${absPath} is ${formatMegabytes(stat.size)}; the media reader accepts images up to ${formatMegabytes(MAX_IMAGE_BYTES)}.`,
      );
    }
    const buffer = await fs.promises.readFile(absPath);
    return {
      kind: 'image',
      mimeType,
      size: buffer.length,
      image: { mimeType, data: buffer.toString('base64'), label: path.basename(absPath) },
    };
  }

  if (isPdfHeader(header)) {
    const buffer = await fs.promises.readFile(absPath);
    return readPdfPayload(buffer, options);
  }

  return null;
}

async function readPdfPayload(buffer: Buffer, options: { pages?: string }): Promise<MediaReadResultPdf> {
  const warnings: string[] = [];
  const size = buffer.length;
  let pageCount = 0;
  let text = '';
  let truncated = false;
  let images: ToolImage[] = [];
  let pages: number[] = [];

  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) });

    try {
      const info = await parser.getInfo();
      pageCount = toPageCount(info?.total);
    } catch (error) {
      warnings.push(`Could not read PDF metadata: ${describeError(error)}`);
    }

    try {
      const textResult = await parser.getText({ pageJoiner: PDF_PAGE_JOINER });
      const extracted = typeof textResult?.text === 'string' ? textResult.text : '';
      if (!pageCount) pageCount = toPageCount(textResult?.total);
      if (extracted.length > MAX_PDF_TEXT_CHARS) {
        text = extracted.slice(0, MAX_PDF_TEXT_CHARS);
        truncated = true;
      } else {
        text = extracted;
      }
    } catch (error) {
      warnings.push(`Could not extract PDF text: ${describeError(error)}`);
    }

    if (pageCount > 0) {
      const range = resolvePdfRenderRange(options.pages, pageCount, warnings);
      if (range) {
        try {
          const screenshot = await parser.getScreenshot({
            first: range.first,
            last: range.last,
            imageDataUrl: false,
            imageBuffer: true,
            scale: PDF_RENDER_SCALE,
          });
          const renderedPages = (screenshot?.pages ?? []).filter((page) => page.data && page.data.length > 0);
          images = renderedPages.map((page) => ({
            mimeType: IMAGE_MIME_PNG,
            data: Buffer.from(page.data).toString('base64'),
            label: `page ${page.pageNumber}`,
          }));
          pages = renderedPages.length ? renderedPages.map((page) => page.pageNumber) : range.pages;
          if (!images.length) warnings.push('PDF pages were not rendered to images.');
        } catch (error) {
          warnings.push(`Could not render PDF pages: ${describeError(error)}`);
          pages = range.pages;
        }
      }
    } else if (size > 0) {
      warnings.push('PDF reports no pages; page screenshots are unavailable.');
    }
  } catch (error) {
    // Constructing the parser can fail for corrupt or encrypted documents.
    warnings.push(`Could not open PDF: ${describeError(error)}`);
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        // Tearing down a failed parser is best effort.
      }
    }
  }

  return { kind: 'pdf', size, pageCount, pages, text, truncated, images, warnings };
}

interface PdfRenderRange { first: number; last: number; pages: number[] }

function resolvePdfRenderRange(spec: unknown, pageCount: number, warnings: string[]): PdfRenderRange | null {
  if (pageCount <= 0) return null;
  const raw = typeof spec === 'string' ? spec.trim() : '';
  if (!raw) return defaultRenderRange(pageCount);

  let selected = parseRequestedPages(raw, pageCount);
  if (!selected.length) {
    warnings.push(`Ignored pages="${raw}": no page numbers between 1 and ${pageCount} were found; rendering the first page(s) instead.`);
    return defaultRenderRange(pageCount);
  }
  if (selected.length > MAX_PDF_RENDER_PAGES) {
    warnings.push(`Requested ${selected.length} PDF pages; only the first ${MAX_PDF_RENDER_PAGES} are rendered.`);
    selected = selected.slice(0, MAX_PDF_RENDER_PAGES);
  }
  const first = selected[0];
  let last = selected[selected.length - 1];
  if (last - first + 1 > MAX_PDF_RENDER_PAGES) {
    last = first + MAX_PDF_RENDER_PAGES - 1;
    warnings.push(`Requested PDF pages are not contiguous; rendering pages ${first}-${last} instead.`);
  }
  const pages: number[] = [];
  for (let page = first; page <= last; page += 1) pages.push(page);
  return { first, last, pages };
}

function defaultRenderRange(pageCount: number): PdfRenderRange {
  const last = Math.min(MAX_PDF_RENDER_PAGES, pageCount);
  const pages: number[] = [];
  for (let page = 1; page <= last; page += 1) pages.push(page);
  return { first: 1, last, pages };
}

/** Parse `"1-3"`, `"2"`, `"1,4"`, `"3-"` … into a sorted, de-duplicated page list clipped to the document. */
function parseRequestedPages(spec: string, pageCount: number): number[] {
  const selected = new Set<number>();
  for (const token of spec.split(/[,\s;]+/)) {
    if (!token) continue;
    const range = /^(\d+)\s*-\s*(\d*)$/.exec(token);
    if (range) {
      let start = Number(range[1]);
      let end = range[2] ? Number(range[2]) : pageCount;
      if (start > end) [start, end] = [end, start];
      for (let page = Math.max(1, start); page <= Math.min(end, pageCount); page += 1) selected.add(page);
      continue;
    }
    if (/^\d+$/.test(token)) {
      const page = Number(token);
      if (page >= 1 && page <= pageCount) selected.add(page);
    }
  }
  return [...selected].sort((left, right) => left - right);
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  // 8-byte signature, 4-byte length, "IHDR", then width/height as big-endian uint32.
  if (buffer.length < 24 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function gifDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 10) return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function bmpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 18) return null;
  const dibHeaderSize = buffer.readUInt32LE(14);
  if (dibHeaderSize === 12) {
    // BITMAPCOREHEADER: 16-bit width/height.
    if (buffer.length < 22) return null;
    const width = buffer.readUInt16LE(18);
    const height = buffer.readUInt16LE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (buffer.length < 26) return null;
  const width = Math.abs(buffer.readInt32LE(18));
  const height = Math.abs(buffer.readInt32LE(22));
  return width > 0 && height > 0 ? { width, height } : null;
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    // 24-bit little-endian (value - 1) canvas dimensions.
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8L') {
    // Lossless bitstream header: 14-bit width-1 followed by 14-bit height-1.
    if (buffer.length < 25) return null;
    const bits = (buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24)) >>> 0;
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >>> 14) & 0x3fff);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8 ') {
    // Lossy key-frame: 3-byte frame tag, start code 9D 01 2A, then 14-bit dimensions.
    if (buffer.length < 30) return null;
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  // Walk the marker segments until a Start-Of-Frame segment carries the size.
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers: TEM, RSTn, SOI. EOI/SOS means no frame header before data.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 4 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function isPdfHeader(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.toString('latin1', 0, 5) === '%PDF-';
}

async function readHeaderSample(target: string, byteCount: number): Promise<Buffer> {
  const handle = await fs.promises.open(target, 'r');
  try {
    const sample = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(sample, 0, byteCount, 0);
    return sample.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function toPageCount(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_WARNING_DETAIL_CHARS ? `${message.slice(0, MAX_WARNING_DETAIL_CHARS)}…` : message;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
