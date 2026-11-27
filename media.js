'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const logger = require('./logger');

let baileys;
async function getBaileys() {
  if (!baileys) baileys = await import('@whiskeysockets/baileys');
  return baileys;
}

function tmpDir() {
  const dir = path.resolve(process.cwd(), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Baileys sometimes wraps documents in a caption container.
function unwrap(msg) {
  const content = msg?.message || {};
  return content.documentWithCaptionMessage?.message || content;
}

function mediaInfo(msg) {
  const content = unwrap(msg);
  if (content.imageMessage) return { message: content.imageMessage, kind: 'image' };
  if (content.videoMessage) return { message: content.videoMessage, kind: 'video' };
  if (content.documentMessage) return { message: content.documentMessage, kind: 'document' };
  if (content.stickerMessage) return { message: content.stickerMessage, kind: 'sticker' };
  return null;
}

function isImageMessage(msg) {
  const info = mediaInfo(msg);
  if (!info) return false;
  return info.kind === 'image' || info.kind === 'sticker' ||
    (info.kind === 'document' && String(info.message.mimetype || '').startsWith('image/'));
}

async function downloadMedia(sock, msg) {
  const info = mediaInfo(msg);
  if (!info) throw new Error('No image, video or document found in that message.');

  // Build the smallest valid message shape for Baileys' decryptor.
  const target = {
    key: msg.key,
    message: { [info.kind + 'Message']: info.message }
  };

  const { downloadMediaMessage } = await getBaileys();
  const buffer = await downloadMediaMessage(target, 'buffer', {}, {
    logger: sock?.logger || { warn() {}, error() {} }
  });
  if (!buffer || !buffer.length) throw new Error('Could not download that media. It may have expired.');
  return { buffer, ...info };
}

function image(buffer) {
  return sharp(buffer).rotate();
}

async function toPng(buffer) {
  return image(buffer).png({ compressionLevel: 9 }).toBuffer();
}

async function toJpeg(buffer) {
  return image(buffer).jpeg({ quality: 90 }).toBuffer();
}

// Adds a transparent margin so WhatsApp previews look cleaner.
async function padImage(buffer, padding = 40) {
  const base = image(buffer);
  const { width, height } = await base.metadata();
  return base.extend({
    top: padding, bottom: padding, left: padding, right: padding,
    background: { r: 255, g: 255, b: 255, alpha: 0 }
  }).png().toBuffer();
}

// Fit images onto A4 pages, one per page, preserving aspect ratio.
async function imagesToPdf(buffers) {
  if (!buffers.length) throw new Error('No images to put into the PDF.');
  const pdf = await PDFDocument.create();
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 28;

  for (const input of buffers) {
    const meta = await image(input).metadata();
    const usableW = pageWidth - margin * 2;
    const usableH = pageHeight - margin * 2;
    const scale = Math.min(usableW / meta.width, usableH / meta.height);
    const width = meta.width * scale;
    const height = meta.height * scale;

    let embedded;
    if (meta.hasAlpha) {
      embedded = await pdf.embedPng(await toPng(input));
    } else {
      embedded = await pdf.embedJpg(await toJpeg(input));
    }

    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, {
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height
    });
  }

  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------
// Background removal
// ---------------------------------------------------------------------------

const REMBG_PY = path.resolve(__dirname, '.venv-rembg/bin/python');
const REMBG_SCRIPT = [
  'import sys, io',
  'from rembg import remove',
  'data = sys.stdin.buffer.read()',
  'out = remove(data)',
  'sys.stdout.buffer.write(out if isinstance(out, bytes) else out.read())'
].join('\n');

function rembgAvailable() {
  return fs.existsSync(REMBG_PY);
}

function runRembg(buffer) {
  return new Promise((resolve, reject) => {
    const child = execFile(REMBG_PY, ['-c', REMBG_SCRIPT], {
      encoding: 'buffer',
      maxBuffer: 30 * 1024 * 1024,
      timeout: 120000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    }, (error, stdout) => {
      if (error) return reject(error);
      if (!stdout || !stdout.length) return reject(new Error('rembg returned no image'));
      resolve(Buffer.from(stdout));
    });
    if (child.stdin) {
      child.stdin.on('error', reject);
      child.stdin.end(buffer);
    }
  });
}

function colorDistance(a, b, offsetA, offsetB) {
  const dr = a[offsetA] - b[offsetB];
  const dg = a[offsetA + 1] - b[offsetB + 1];
  const db = a[offsetA + 2] - b[offsetB + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Offline fallback: flood-fill from the image borders. Works well on solid or
// near-solid backgrounds (ID photos, product shots, documents). Keyless and
// dependency-free, so it still works on Render.
async function floodFillBackground(buffer, threshold = 42) {
  const maxSide = 1100;
  let pipeline = image(buffer);
  const meta = await pipeline.metadata();
  if (Math.max(meta.width, meta.height) > maxSide) {
    pipeline = pipeline.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true });
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pixels = Buffer.from(data);
  const visited = new Uint8Array(width * height);

  // Seed colours = corners plus midpoint samples of each border.
  const points = [
    [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
    [Math.floor(width / 2), 0], [Math.floor(width / 2), height - 1],
    [0, Math.floor(height / 2)], [width - 1, Math.floor(height / 2)]
  ];
  const seeds = points.map(([x, y]) => {
    const offset = (y * width + x) * channels;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  });

  const matches = (offset) => seeds.some(seed => {
    const dr = pixels[offset] - seed[0];
    const dg = pixels[offset + 1] - seed[1];
    const db = pixels[offset + 2] - seed[2];
    return dr * dr + dg * dg + db * db < threshold * threshold;
  });

  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const push = (x, y) => {
    const index = y * width + x;
    if (visited[index]) return;
    visited[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    const offset = index * channels;
    if (!matches(offset)) continue;
    if (channels === 4) pixels[offset + 3] = 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

async function removeBackground(buffer) {
  if (rembgAvailable()) {
    try {
      const result = await runRembg(buffer);
      return image(result).png().toBuffer();
    } catch (error) {
      logger.warn('rembg failed, using offline removal:', error.message);
    }
  }
  return floodFillBackground(buffer);
}

module.exports = {
  mediaInfo,
  isImageMessage,
  downloadMedia,
  toPng,
  toJpeg,
  padImage,
  imagesToPdf,
  removeBackground,
  floodFillBackground,
  rembgAvailable,
  tmpDir
};
