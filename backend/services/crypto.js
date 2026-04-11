'use strict';
const crypto = require('crypto');

// Fail-closed — pas de fallback aléatoire (new key on each cold start = IBAN illisibles)
if (!process.env.ENCRYPTION_KEY) {
  throw new Error('[FATAL] ENCRYPTION_KEY is missing from environment variables');
}
if (process.env.ENCRYPTION_KEY.length !== 64) {
  throw new Error('[FATAL] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
}
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
const ALG = 'aes-256-gcm';

function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(data) {
  if (!data || !data.includes(':')) return data;
  try {
    const [ivHex, tagHex, encHex] = data.split(':');
    const decipher = crypto.createDecipheriv(ALG, KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')).toString('utf8') + decipher.final('utf8');
  } catch { return data; }
}

module.exports = { encrypt, decrypt };
