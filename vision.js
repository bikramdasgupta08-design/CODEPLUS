'use strict';

const config = require('./config');
const logger = require('./logger');

// Gemini can read images inline. Different accounts expose different models,
// so we try the same quality-ordered chain used for text.
async function askVision(prompt, buffer, mimeType = 'image/jpeg') {
  if (!config.geminiApiKey) throw new Error('No Gemini API key configured for image understanding.');

  const models = [config.aiModel, ...config.aiFallbackModels.filter(m => m !== config.aiModel)];
  const parts = [
    { text: prompt },
    { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }
  ];
  let lastError;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: 'You are CODEPLUS, a careful visual assistant. Describe images accurately and never invent details you cannot see.' }]
          },
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.3 }
        }),
        signal: AbortSignal.timeout(config.imageTimeoutMs || 60000)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `Gemini vision error ${response.status}`);
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (!text) throw new Error('Gemini vision returned an empty reply');
      return text;
    } catch (error) {
      lastError = error;
      logger.debug('VISION_MODEL_FAILED', { model, error: error.message });
    }
  }

  throw lastError || new Error('No Gemini vision model available');
}

// Social-media style caption from an actual image (not a made-up one).
async function imageCaption(buffer, mimeType) {
  return askVision([
    'Look at this image carefully.',
    'Write a short, natural WhatsApp/Instagram caption for it.',
    'Include only things that are actually visible. Add 3-5 relevant hashtags on the last line.',
    'Return only the caption.'
  ].join('\n'), buffer, mimeType);
}

module.exports = { askVision, imageCaption };
