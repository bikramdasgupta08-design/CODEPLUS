'use strict';

const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'bot-debug.log');
const stamp = () => new Date().toISOString();

function format(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch (_) {
    return String(arg);
  }
}

function write(level, args) {
  try {
    fs.appendFileSync(logFile, `[${stamp()}] ${level} ${args.map(format).join(' ')}\n`);
  } catch (_) {
    // Never let logging break the bot.
  }
}

module.exports = {
  info: (...args) => {
    console.log(`[${stamp()}] INFO`, ...args);
    write('INFO', args);
  },
  warn: (...args) => {
    console.warn(`[${stamp()}] WARN`, ...args);
    write('WARN', args);
  },
  error: (...args) => {
    console.error(`[${stamp()}] ERROR`, ...args);
    write('ERROR', args);
  },
  debug: (...args) => write('DEBUG', args)
};
