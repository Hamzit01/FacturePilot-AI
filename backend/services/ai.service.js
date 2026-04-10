'use strict';
/**
 * Service IA — génération de relances commerciales personnalisées
 * Modèle : gpt-4o-mini  (coût minimal, latence faible)
 * Fallback : template statique si OPENAI_API_KEY absent ou quota dépassé
 */
const OpenAI = require('openai');

// Singleton — instancié une seule fois, pas à chaque requête
let _client = null;
const getClient = () => {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY non défini');
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
};

// ── Prompt système (optimisé pour le droit commercial français) ──────────────
const SYSTEM_PROMPT = `Tu es un expert juridique et commercial français, spécialisé dans le recouvrement de créances B2B.
Tu rédiges des emails de relance pour des factures impayées.

Règles absolues :
- Langue : français professionnel, sans fautes
- Format : email complet (objet + corps), sans balises HTML, sans markdown
- Longueur : 120–200 mots maximum
- Ne jamais menacer de poursuites judiciaires avant J+45
- Respecter la hiérarchie des tons selon l'ancienneté du retard
- Inclure toujours : montant TTC, numéro de facture s'il est fourni, échéance dépassée en jours
- Terminer par une formule de politesse adaptée au ton

Hiérarchie des tons :
  courtois  → rappel amical, on suppose un oubli, ton chaleureux
  ferme     → deuxième relance, on rappelle l'obligation contractuelle, ton neutre et direct
  urgent    → troisième relance, mise en cause, risque de pénalités de retard (art. L441-10 C.com)
  mise_en_demeure → courrier formel, mention des intérêts légaux, délai de 8 jours avant mise en recouvrement

Structure de réponse STRICTE (deux blocs séparés par une ligne vide) :
OBJET: <sujet de l'email>

<corps de l'email>`;

// ── Mapping tone → instruction ────────────────────────────────────────────────
const TONE_INSTRUCTIONS = {
  courtois:         'Ton : courtois et amical. Supposer un simple oubli.',
  ferme:            'Ton : ferme et professionnel. Rappeler l\'obligation de paiement.',
  urgent:           'Ton : urgent. Mentionner les pénalités de retard légales (art. L441-10).',
  mise_en_demeure:  'Ton : mise en demeure formelle. Délai de 8 jours avant recouvrement externe.',
};

/**
 * generateDunningEmail
 *
 * @param {string}   clientName  — Nom du client (entreprise ou prénom/nom)
 * @param {number}   amount      — Montant TTC en euros
 * @param {number}   daysLate    — Nombre de jours de retard
 * @param {string}   tone        — 'courtois' | 'ferme' | 'urgent' | 'mise_en_demeure'
 * @param {object[]} history     — Historique des relances précédentes :
 *                                 [{ date: 'YYYY-MM-DD', tone: 'courtois' }, ...]
 * @param {object}   [opts]      — Options facultatives : { invoiceNumber, senderName, senderCompany }
 *
 * @returns {Promise<{ subject: string, body: string }>}
 */
const generateDunningEmail = async (clientName, amount, daysLate, tone, history = [], opts = {}) => {
  const toneInstruction = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.courtois;

  const historyText = history.length
    ? `Relances déjà envoyées : ${history.map(h => `${h.date} (${h.tone})`).join(', ')}.`
    : 'Première relance.';

  const invoiceRef = opts.invoiceNumber ? `Référence facture : ${opts.invoiceNumber}.` : '';
  const sender     = opts.senderName
    ? `Expéditeur : ${opts.senderName}${opts.senderCompany ? ` — ${opts.senderCompany}` : ''}.`
    : '';

  const userPrompt = [
    `Client : ${clientName}.`,
    `Montant impayé : ${Number(amount).toFixed(2)} € TTC.`,
    `Retard : ${daysLate} jour(s).`,
    invoiceRef,
    historyText,
    sender,
    toneInstruction,
  ].filter(Boolean).join('\n');

  try {
    const openai = getClient();

    const completion = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0.4,      // Faible variabilité — ton professionnel reproductible
      max_tokens:  500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    return parseResponse(raw, clientName, amount, daysLate, tone);

  } catch (err) {
    console.error('[AI] generateDunningEmail error:', err.message);
    // Fallback statique — ne jamais bloquer la relance pour une erreur IA
    return staticFallback(clientName, amount, daysLate, tone, opts);
  }
};

// ── Parser la réponse LLM (format: "OBJET: ...\n\n<corps>") ─────────────────
const parseResponse = (raw, clientName, amount, daysLate, tone) => {
  const lines   = raw.split('\n');
  const objLine = lines.find(l => l.startsWith('OBJET:') || l.startsWith('Objet:'));
  const subject = objLine
    ? objLine.replace(/^(OBJET|Objet):\s*/i, '').trim()
    : `Relance — Facture impayée de ${amount.toFixed(2)} €`;

  // Corps = tout après la ligne OBJET + la ligne vide suivante
  const bodyStart = objLine ? lines.indexOf(objLine) + 1 : 0;
  const body = lines
    .slice(bodyStart)
    .join('\n')
    .replace(/^\n+/, '')   // supprimer les lignes vides initiales
    .trim();

  return { subject, body };
};

// ── Fallback statique (si pas de clé API ou quota dépassé) ──────────────────
const staticFallback = (clientName, amount, daysLate, tone, opts = {}) => {
  const invoice = opts.invoiceNumber ? ` (réf. ${opts.invoiceNumber})` : '';
  const subjects = {
    courtois:        `Rappel — Facture de ${amount.toFixed(2)} € en attente de règlement`,
    ferme:           `2ème relance — Facture impayée de ${amount.toFixed(2)} €`,
    urgent:          `URGENT — Facture de ${amount.toFixed(2)} € — Retard de ${daysLate} jours`,
    mise_en_demeure: `Mise en demeure — Facture${invoice} de ${amount.toFixed(2)} € TTC`,
  };
  const bodies = {
    courtois: `Bonjour,\n\nNous vous contactons au sujet de votre facture${invoice} d'un montant de ${amount.toFixed(2)} € TTC, dont le règlement est en attente depuis ${daysLate} jour(s).\n\nPeut-être s'agit-il d'un simple oubli ? Nous vous invitons à procéder au règlement dans les meilleurs délais.\n\nRestant à votre disposition pour tout renseignement.\n\nCordialement`,
    ferme:    `Bonjour,\n\nMalgré notre précédent rappel, nous constatons que la facture${invoice} de ${amount.toFixed(2)} € TTC demeure impayée (retard : ${daysLate} jours).\n\nNous vous demandons de bien vouloir régulariser cette situation sous 5 jours ouvrés.\n\nCordialement`,
    urgent:   `Bonjour,\n\nNous vous informons que la facture${invoice} de ${amount.toFixed(2)} € TTC accuse un retard de ${daysLate} jours. Conformément à l'article L441-10 du Code de commerce, des pénalités de retard sont applicables à compter de la date d'échéance.\n\nNous vous demandons de régulariser cette situation immédiatement.\n\nCordialement`,
    mise_en_demeure: `Madame, Monsieur,\n\nPar la présente, nous vous mettons en demeure de régler la facture${invoice} d'un montant de ${amount.toFixed(2)} € TTC, impayée depuis ${daysLate} jours, dans un délai de 8 jours à compter de la réception de ce courrier.\n\nA défaut, nous nous réserverons le droit d'engager toute procédure de recouvrement utile, aux frais du débiteur.\n\nVeuillez agréer nos salutations distinguées`,
  };

  return {
    subject: subjects[tone] || subjects.courtois,
    body:    bodies[tone]   || bodies.courtois,
  };
};

module.exports = { generateDunningEmail };
