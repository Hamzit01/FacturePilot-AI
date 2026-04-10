'use strict';
const crypto = require('crypto');

const KEY = Buffer.from(
  process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex').slice(0, 64),
  'hex'
);
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
