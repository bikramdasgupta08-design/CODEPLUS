'use strict';

const config = require('./config');
const logger = require('./logger');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Pollinations' keyless tier allows roughly one image per 45 seconds per IP.
// Space our own requests so consecutive !img commands do not trip the limit.
let nextImageAt = 0;

async function tryGemini(prompt) {
  if (!config.geminiApiKey) throw new Error('No GEMINI_API_KEY configured');
  let lastError;

  for (const model of config.imageModels || []) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${config.imagePrompt}${prompt}` }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        }),
        signal: AbortSignal.timeout(config.imageTimeoutMs || 60000)
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error?.message || `Gemini image error ${response.status}`);
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const image = parts.find(part => part.inlineData?.data);
      if (!image) throw new Error(`${model} returned no image`);

      const buffer = Buffer.from(image.inlineData.data, 'base64');
      if (!buffer.length) throw new Error(`${model} returned an empty image`);

      return {
        buffer,
        mimeType: image.inlineData.mimeType || 'image/png',
        source: `Gemini (${model})`
      };
    } catch (error) {
      lastError = error;
      logger.warn(`Gemini image model ${model} failed:`, error.message);
    }
  }

  throw lastError || new Error('All Gemini image models failed');
}

async function tryPollinations(prompt) {
  const models = ['sana', 'flux', '']; // '' = endpoint default
  let lastError;

  for (let attempt = 0; attempt < models.length; attempt++) {
    const wait = nextImageAt - Date.now();
    if (wait > 0) await sleep(wait);

    const model = models[attempt];
    const modelParam = model ? `&model=${model}` : '';
    const url = `${config.imageFallbackUrl}${encodeURIComponent(prompt)}?width=512&height=512&nologo=true${modelParam}`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(config.imageTimeoutMs || 60000)
      });

      if (!response.ok) {
        const raw = await response.text();
        let message = raw;
        try {
          const data = JSON.parse(raw);
          message = data?.error?.message || data?.message || raw;
        } catch (_) {
          // Not JSON; keep the raw text.
        }
        const match = String(message).match(/Retry after (\d+)s/i);
        const delay = match ? Math.min(Number(match[1]) + 2, 60) : 10;
        nextImageAt = Date.now() + delay * 1000;
        throw new Error(`Pollinations image error ${response.status}: ${message.slice(0, 160)}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        throw new Error(`Pollinations returned ${contentType || 'unknown content type'}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1000) throw new Error('Pollinations returned an empty image');

      nextImageAt = Date.now() + 46 * 1000;
      return {
        buffer,
        mimeType: contentType.split(';')[0].trim(),
        source: `Pollinations (keyless${model ? `, ${model}` : ''})`
      };
    } catch (error) {
      lastError = error;
      logger.warn(`Pollinations image attempt ${attempt + 1} failed:`, error.message);
    }
  }

  throw lastError || new Error('Pollinations image generation unavailable');
}

async function generateImage(prompt) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('Empty image prompt');

  if (config.geminiApiKey) {
    try {
      return await tryGemini(clean);
    } catch (error) {
      logger.warn('Gemini image path failed, using keyless fallback:', error.message);
    }
  }

  return tryPollinations(clean);
}

module.exports = { generateImage, tryGemini, tryPollinations };
