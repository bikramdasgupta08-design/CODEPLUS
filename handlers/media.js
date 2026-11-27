'use strict';

const {
  downloadMedia,
  isImageMessage,
  toPng,
  imagesToPdf,
  removeBackground,
  padImage,
  mediaInfo
} = require('../media');
const { askVision, imageCaption } = require('../vision');
const logger = require('../logger');

const send = (sock, jid, text) => sock.sendMessage(jid, { text });

// Accepts either an image sent with the command as its caption, or a reply to
// an image (Baileys exposes the quoted message in contextInfo).
function resolveImageMessage(msg) {
  if (isImageMessage(msg)) return msg;

  const context = msg?.message?.extendedTextMessage?.contextInfo ||
    msg?.message?.imageMessage?.contextInfo;
  const quoted = context?.quotedMessage;
  if (quoted && isImageMessage({ message: quoted })) {
    return {
      key: {
        remoteJid: context.remoteJid || msg?.key?.remoteJid,
        id: context.stanzaId,
        participant: context.participant || context.participantJid
      },
      message: quoted
    };
  }
  return null;
}

async function getImages(sock, msg) {
  const target = resolveImageMessage(msg);
  if (!target) throw new Error('Send an image with this command as its caption, or reply to an image with it.');

  const { buffer, message } = await downloadMedia(sock, target);
  const mime = message.mimetype || 'image/jpeg';
  return { buffer, mime };
}

async function makePdf({ sock, jid, msg }) {
  await send(sock, jid, '📄 Converting image to PDF, please wait...');
  try {
    const { buffer } = await getImages(sock, msg);
    const pdf = await imagesToPdf([await toPng(buffer)]);
    await sock.sendMessage(jid, {
      document: pdf,
      fileName: `CODEPLUS-${Date.now()}.pdf`,
      mimetype: 'application/pdf',
      caption: '📄 Created by CODEPLUS'
    });
    logger.debug('IMAGE_TO_PDF_OK');
  } catch (error) {
    logger.warn('IMAGE_TO_PDF_FAILED', { error: error.message });
    await send(sock, jid, `PDF conversion failed: ${error.message}`);
  }
}

async function makePng({ sock, jid, msg }) {
  await send(sock, jid, '🖼️ Converting image to PNG, please wait...');
  try {
    const { buffer } = await getImages(sock, msg);
    const png = await padImage(await toPng(buffer), 16);
    await sock.sendMessage(jid, { image: png, caption: '🖼️ PNG converted by CODEPLUS' });
    logger.debug('IMAGE_TO_PNG_OK');
  } catch (error) {
    logger.warn('IMAGE_TO_PNG_FAILED', { error: error.message });
    await send(sock, jid, `PNG conversion failed: ${error.message}`);
  }
}

async function noBackground({ sock, jid, msg }) {
  await send(sock, jid, '✂️ Removing background, please wait...');
  try {
    const { buffer } = await getImages(sock, msg);
    const result = await removeBackground(buffer);
    await sock.sendMessage(jid, { image: result, caption: '✂️ Background removed by CODEPLUS' });
    logger.debug('BACKGROUND_REMOVED');
  } catch (error) {
    logger.warn('BACKGROUND_REMOVE_FAILED', { error: error.message });
    await send(sock, jid, `Background removal failed: ${error.message}`);
  }
}

async function describe({ sock, jid, msg, args }, mode = 'describe') {
  const userPrompt = args.join(' ').trim();
  await send(sock, jid, mode === 'caption' ? '✍️ Writing a caption, please wait...' : '👁️ Looking at the image, please wait...');
  try {
    const { buffer, mime } = await getImages(sock, msg);
    const prompt = mode === 'caption'
      ? (userPrompt || undefined)
      : (userPrompt || 'Describe this image in detail. Read any visible text exactly.');
    const text = mode === 'caption' && !userPrompt
      ? await imageCaption(buffer, mime)
      : await askVision(prompt, buffer, mime);
    await send(sock, jid, text);
    logger.debug('VISION_OK', { mode });
  } catch (error) {
    logger.warn('VISION_FAILED', { mode, error: error.message });
    await send(sock, jid, `Could not read that image: ${error.message}`);
  }
}

const handlers = {
  pdf: makePdf,
  png: makePng,
  nobg: noBackground,
  removebg: noBackground,
  describe: ({ sock, jid, msg, args }) => describe({ sock, jid, msg, args }, 'describe'),
  caption: ({ sock, jid, msg, args }) => describe({ sock, jid, msg, args }, 'caption')
};

// Natural captions: an image plus "make pdf", "remove background", etc.
async function handleImageCaption(sock, jid, msg, body, config) {
  const target = resolveImageMessage(msg);
  if (!target) return false;
  const text = String(body || '').trim();
  if (!text || text.startsWith(config.prefix)) return false;

  const lower = text.toLowerCase();
  let action;
  if (/\b(make (it )?(a )?pdf|convert (it )?(to )?pdf|\bpdf\b)\b/.test(lower)) action = 'pdf';
  else if (/\b(remove (the |its )?back(ground)?|background remove|nobg|no bg|transparent background)\b/.test(lower)) action = 'nobg';
  else if (/\b(make (it )?(a )?png|convert (it )?(to )?png|\bpng\b)\b/.test(lower)) action = 'png';
  else if (/\b(caption|write a caption|social media caption)\b/.test(lower)) action = 'caption';
  else if (/\b(describe|what is (this|it)|explain (this|the) image|read this)\b/.test(lower)) action = 'describe';
  else return false;

  await handlers[action]({ sock, jid, msg, args: [] });
  return true;
}

module.exports = { ...handlers, handleImageCaption, resolveImageMessage };
