'use strict';
const nodemailer = require('nodemailer');

/**
 * Crée un transporteur Nodemailer à partir des variables .env
 * Si SMTP_USER/PASS sont vides → mode "éthéré" (prévisualisation Ethereal en dev)
 */
function createTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

  if (!SMTP_USER || !SMTP_PASS) {
    // Pas de config SMTP → retourner null (les appels seront silencieux)
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST || 'smtp-relay.brevo.com',
    port: parseInt(SMTP_PORT || '587'),
    secure: false, // STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/**
 * Envoie un email.
 * @param {object} opts – { to, subject, html, text }
 * @returns {Promise<object>} info nodemailer ou { simulated: true }
 */
async function sendMail({ to, subject, html, text }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.log(`[MAIL SIMULÉ] → ${to} | ${subject}`);
    return { simulated: true };
  }
  const from = process.env.SMTP_FROM || 'noreply@facturepilot.ai';
  return transporter.sendMail({ from, to, subject, html, text });
}

/**
 * Vérifie la connexion SMTP et retourne { ok, message }
 */
async function testConnection() {
  const transporter = createTransporter();
  if (!transporter) {
    return { ok: false, message: 'SMTP non configuré (SMTP_USER / SMTP_PASS manquants dans .env)' };
  }
  try {
    await transporter.verify();
    return { ok: true, message: 'Connexion SMTP OK ✓' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { sendMail, testConnection };
