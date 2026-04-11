'use strict';
/**
 * Service IA — génération de relances commerciales via Gemini 1.5 Flash
 * Tier gratuit Google : 15 req/min, 1 500 req/jour, 0 €
 * Fallback statique automatique si GEMINI_API_KEY absent ou quota dépassé
 */
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// ── Singleton ─────────────────────────────────────────────────────────────────
let _model = null;

const getModel = () => {
  if (_model) return _model;
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY non défini');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  _model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    // Safety settings : BLOCK_NONE sur toutes les catégories sensibles
    // Obligatoire — les relances "mise_en_demeure" déclenchent le filtre harassment
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: {
      temperature:     0.4,   // reproductible, ton professionnel stable
      maxOutputTokens: 512,
      topP:            0.9,
    },
  });

  return _model;
};

// ── Prompt système (optimisé droit commercial français) ───────────────────────
const SYSTEM_PROMPT = `Tu es un expert juridique et commercial français spécialisé dans le recouvrement de créances B2B.
Tu rédiges des emails de relance pour des factures impayées.

Règles absolues :
- Langue : français professionnel, sans fautes
- Format STRICT : deux blocs séparés par une ligne vide
    OBJET: <sujet>

    <corps de l'email>
- Longueur corps : 80 à 150 mots maximum
- Inclure toujours : montant TTC, numéro de facture si fourni, jours de retard
- Terminer par une formule de politesse adaptée au ton

Hiérarchie des tons :
  courtois        → rappel amical, suppose un oubli, ton chaleureux
  ferme           → 2ème relance, obligation contractuelle, ton neutre et direct
  urgent          → 3ème relance, pénalités de retard légales (art. L441-10 C.com)
  mise_en_demeure → courrier formel, délai de 8 jours, intérêts légaux, recouvrement externe`;

// ── Mapping tone → instruction ─────────────────────────────────────────────────
const TONE_INSTRUCTIONS = {
  courtois:        'Ton : courtois et amical. Suppose un simple oubli.',
  ferme:           "Ton : ferme et professionnel. Rappelle l'obligation contractuelle de paiement.",
  urgent:          'Ton : urgent. Mentionne les pénalités légales (art. L441-10 C.com).',
  mise_en_demeure: 'Ton : mise en demeure formelle. Délai de 8 jours avant recouvrement externe. Mentionne les intérêts légaux.',
};

// ── generateDunningEmail ───────────────────────────────────────────────────────
/**
 * @param {string}   clientName  — Nom du client
 * @param {number}   amount      — Montant TTC en euros
 * @param {number}   daysLate    — Jours de retard
 * @param {string}   tone        — 'courtois' | 'ferme' | 'urgent' | 'mise_en_demeure'
 * @param {object[]} history     — [{ date, ton }, ...] relances précédentes
 * @param {object}   opts        — { invoiceNumber, senderName, senderCompany }
 * @returns {Promise<{ subject: string, body: string }>}
 */
const generateDunningEmail = async (clientName, amount, daysLate, tone, history = [], opts = {}) => {
  const toneInstruction = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.courtois;

  const historyText = history.length
    ? `Relances déjà envoyées : ${history.map(h => `${h.date} (${h.ton})`).join(', ')}.`
    : 'Première relance.';

  const invoiceRef = opts.invoiceNumber ? `Référence facture : ${opts.invoiceNumber}.` : '';
  const sender     = opts.senderName
    ? `Expéditeur : ${opts.senderName}${opts.senderCompany ? ` — ${opts.senderCompany}` : ''}.`
    : '';

  const prompt = [
    SYSTEM_PROMPT,
    '',
    `Client : ${clientName}.`,
    `Montant impayé : ${Number(amount).toFixed(2)} € TTC.`,
    `Retard : ${daysLate} jour(s).`,
    invoiceRef,
    historyText,
    sender,
    toneInstruction,
  ].filter(Boolean).join('\n');

  try {
    const model  = getModel();
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim();

    // Vérification blocage Gemini (safety triggered malgré BLOCK_NONE)
    const candidate = result.response.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      console.warn('[AI] Gemini safety block — fallback statique');
      return staticFallback(clientName, amount, daysLate, tone, opts);
    }

    return parseResponse(raw, amount, tone);

  } catch (err) {
    console.error('[AI] Gemini error:', err.message);
    return staticFallback(clientName, amount, daysLate, tone, opts);
  }
};

// ── Parser la réponse (format: "OBJET: ...\n\n<corps>") ──────────────────────
const parseResponse = (raw, amount, tone) => {
  const lines   = raw.split('\n');
  const objLine = lines.find(l => /^(OBJET|Objet)\s*:/i.test(l));
  const subject = objLine
    ? objLine.replace(/^(OBJET|Objet)\s*:\s*/i, '').trim()
    : `Relance — Facture impayée de ${Number(amount).toFixed(2)} €`;

  const bodyStart = objLine ? lines.indexOf(objLine) + 1 : 0;
  const body = lines
    .slice(bodyStart)
    .join('\n')
    .replace(/^\n+/, '')
    .trim();

  return { subject, body: body || staticFallback('', amount, 0, tone).body };
};

// ── Fallback statique (Dumb Dunning) ─────────────────────────────────────────
const staticFallback = (clientName, amount, daysLate, tone, opts = {}) => {
  const amt     = Number(amount).toFixed(2);
  const invoice = opts.invoiceNumber ? ` (réf. ${opts.invoiceNumber})` : '';
  const client  = clientName || 'Madame, Monsieur';

  const templates = {
    courtois: {
      subject: `Rappel — Facture${invoice} de ${amt} € en attente de règlement`,
      body:    `Bonjour ${client},\n\nSauf erreur de notre part, votre facture${invoice} d'un montant de ${amt} € TTC est en attente de règlement depuis ${daysLate} jour(s). Il s'agit peut-être d'un simple oubli.\n\nNous vous invitons à procéder au règlement dans les meilleurs délais.\n\nCordialement`,
    },
    ferme: {
      subject: `2ème relance — Facture${invoice} impayée de ${amt} €`,
      body:    `Bonjour ${client},\n\nMalgré notre précédent rappel, votre facture${invoice} de ${amt} € TTC demeure impayée (retard : ${daysLate} jours). Nous vous demandons de régulariser cette situation sous 5 jours ouvrés.\n\nCordialement`,
    },
    urgent: {
      subject: `URGENT — Facture${invoice} de ${amt} € — Retard de ${daysLate} jours`,
      body:    `Bonjour ${client},\n\nVotre facture${invoice} de ${amt} € TTC accuse un retard de ${daysLate} jours. Conformément à l'art. L441-10 du Code de commerce, des pénalités de retard sont exigibles immédiatement.\n\nNous vous demandons de régulariser sous 48 heures.\n\nCordialement`,
    },
    mise_en_demeure: {
      subject: `Mise en demeure — Facture${invoice} de ${amt} € TTC`,
      body:    `Madame, Monsieur,\n\nPar la présente, nous vous mettons en demeure de régler la facture${invoice} d'un montant de ${amt} € TTC, impayée depuis ${daysLate} jours, dans un délai de 8 jours à compter de la réception du présent courrier.\n\nPassé ce délai, nous engagerons toute procédure de recouvrement utile, aux frais du débiteur.\n\nVeuillez agréer nos salutations distinguées`,
    },
  };

  return templates[tone] || templates.courtois;
};

module.exports = { generateDunningEmail };
