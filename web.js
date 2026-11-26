'use strict';

const config = require('./config');
const logger = require('./logger');

const cache = new Map();
const SKIP = /^(hi|hello|hey|yo|ok|okay|k|thanks|thank you|yes|no|good morning|good evening|good night|pong|test)$/i;

function timeZone() {
  return config.timeZone || 'Asia/Kolkata';
}

function istNow(date = new Date()) {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone(),
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone(),
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
  return `${day}, ${clock} IST`;
}

function decode(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CODEPLUS/1.0 (WhatsApp assistant)' },
    signal: AbortSignal.timeout(config.webContextTimeoutMs || 6000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function wikiContext(query) {
  const searchUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=2&format=json&srsearch=' + encodeURIComponent(query);
  const search = JSON.parse(await getText(searchUrl));
  const pages = search?.query?.search || [];
  if (!pages.length) return '';

  const titles = pages.map(page => page.title).join('|');
  const extractUrl = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&titles=' + encodeURIComponent(titles);
  const extracts = JSON.parse(await getText(extractUrl));
  const rows = Object.values(extracts?.query?.pages || {})
    .map(page => `${page.title}: ${decode(page.extract).slice(0, 400)}`)
    .filter(row => row.length > 30);

  return rows.length ? `Wikipedia: ${rows.join(' | ')}` : '';
}

async function newsContext(query) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-IN&gl=IN&ceid=IN:en';
  const xml = await getText(url);
  const items = xml.split('<item>').slice(1, 4);
  const rows = items.map(item => {
    const title = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const date = decode(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]);
    return title ? `${title} (${date ? date.slice(0, 22) : 'recent'})` : '';
  }).filter(Boolean);

  return rows.length ? `Latest news: ${rows.join(' | ')}` : '';
}

// Builds a short, fresh context block for the AI. Never throws: a failed
// lookup simply means the AI answers from its own knowledge.
async function buildContext(text) {
  if (!config.webSearchEnabled) return '';

  const query = decode(text).slice(0, 120);
  if (query.length < 8 || SKIP.test(query)) return '';

  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < (config.webCacheMs || 600000)) return hit.text;

  const results = await Promise.allSettled([
    wikiContext(query),
    newsContext(query)
  ]);
  const parts = results
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.debug('WEB_LOOKUP_FAILED', result.reason?.message || String(result.reason));
    }
  }

  const context = parts.join('\n').slice(0, config.webMaxChars || 1400);
  cache.set(query, { text: context, at: Date.now() });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return context;
}

module.exports = { istNow, buildContext, wikiContext, newsContext };
