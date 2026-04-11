'use strict';
/**
 * Service email dédié à l'envoi de factures avec pièce jointe PDF
 * Transporteur : Brevo (smtp-relay.brevo.com:587) via Nodemailer
 * Fallback : log simulé si SMTP non configuré (dev)
 */
const nodemailer = require('nodemailer');

// ── Singleton transporter ──────────────────────────────────────────────────────
let _transporter = null;

const getTransporter = () => {
  if (_transporter) return _transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_USER || !SMTP_PASS) {
    return null; // mode simulation
  }

  _transporter = nodemailer.createTransport({
    host:   SMTP_HOST || 'smtp-relay.brevo.com',
    port:   parseInt(SMTP_PORT || '587', 10),
    secure: false,       // STARTTLS sur le port 587
    auth: {
      user: SMTP_USER,   // login Brevo (email du compte)
      pass: SMTP_PASS,   // clé SMTP Brevo (pas le mot de passe du compte)
    },
    pool:           true,   // connexions persistantes (perf)
    maxConnections: 3,
    rateDelta:      1000,   // 1 envoi/sec max (respect des limites Brevo)
    rateLimit:      1,
  });

  return _transporter;
};

// ── sendInvoiceEmail ───────────────────────────────────────────────────────────
/**
 * Envoie un email avec ou sans pièce jointe PDF.
 *
 * @param {string}      to            — Destinataire (ex: "client@example.com")
 * @param {string}      subject       — Objet de l'email
 * @param {string}      htmlBody      — Corps HTML
 * @param {Buffer|null} pdfBuffer     — Buffer du PDF à joindre (null = pas de PJ)
 * @param {string}      invoiceNumber — Numéro de facture (ex: "FA-2026-001")
 * @param {object}      [opts]        — Options supplémentaires
 * @param {string}      [opts.replyTo]
 * @param {string}      [opts.textBody] — Version texte brut de l'email
 *
 * @returns {Promise<object>} — Info nodemailer ou { simulated: true }
 */
const sendInvoiceEmail = async (to, subject, htmlBody, pdfBuffer, invoiceNumber, opts = {}) => {
  const transporter = getTransporter();
  const from        = process.env.SMTP_FROM || 'noreply@facturepilot.ai';

  // ── Construction du message ──────────────────────────────────────────────────
  const message = {
    from,
    to,
    subject,
    html:    htmlBody,
    text:    opts.textBody || htmlBody.replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim(),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    // Headers délivrabilité
    headers: {
      'X-Mailer':     'FacturePilot AI',
      'X-Priority':   '3',               // Normal (1=Haute évite les filtres spam)
      'List-Unsubscribe': `<mailto:unsubscribe@facturepilot.ai?subject=unsubscribe>`,
    },
  };

  // ── Pièce jointe PDF/A-3b (Factur-X) ────────────────────────────────────────
  if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
    const safeNumber = String(invoiceNumber || 'facture').replace(/[^a-zA-Z0-9\-_]/g, '_');
    message.attachments = [
      {
        filename:    `Facture_${safeNumber}.pdf`,
        content:     pdfBuffer,
        contentType: 'application/pdf',    // MIME type strict requis par les PDP
        encoding:    'base64',
      },
    ];
  }

  // ── Envoi ou simulation ──────────────────────────────────────────────────────
  if (!transporter) {
    console.log(`[EMAIL SIMULÉ] → ${to} | ${subject}${pdfBuffer ? ' (+ PDF joint)' : ''}`);
    return { simulated: true };
  }

  try {
    const info = await transporter.sendMail(message);
    console.log(`[EMAIL] ✅ Envoyé → ${to} | messageId: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error(`[EMAIL] ❌ Échec → ${to} :`, err.message);
    throw err; // Remonter pour que le caller puisse logger/retry
  }
};

// ── sendMail (alias simple — rétrocompatibilité avec mailer.js) ───────────────
const sendMail = ({ to, subject, html, text }) =>
  sendInvoiceEmail(to, subject, html, null, null, { textBody: text });

module.exports = { sendInvoiceEmail, sendMail };
