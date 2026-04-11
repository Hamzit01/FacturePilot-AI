'use strict';
/**
 * GET /api/cron/relances — appelé par Vercel Cron Jobs (vercel.json : "*/1 8 * * *")
 * Protégé par requireCronSecret (Authorization: Bearer CRON_SECRET)
 *
 * Logique :
 *  1. Récupère les factures en retard (plan pro/business) à J+7, J+14, J+30
 *  2. Vérifie qu'aucune relance n'a été envoyée aujourd'hui (idempotence)
 *  3. Vérifie live que la facture est toujours 'retard' (guard-rail)
 *  4. Appelle l'IA pour générer l'email, envoie et logue en DB
 */
const db = require('../db');
const { generateDunningEmail } = require('../services/ai.service');
const { sendInvoiceEmail }     = require('../services/email.service');

// Tons par ancienneté du retard
const toneFor = (days) => {
  if (days >= 45) return 'mise_en_demeure';
  if (days >= 30) return 'urgent';
  if (days >= 14) return 'ferme';
  return 'courtois';
};

const runRelances = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const results = { checked: 0, skipped: 0, sent: 0, errors: 0 };

  try {
    // ── 1. Factures éligibles ──────────────────────────────────────────────────
    // Uniquement plans pro/business (quota AI protégé)
    // Jours de retard cibles : 7, 14, 30, 45 (mise en demeure)
    // Pas de relance envoyée aujourd'hui (idempotence cron)
    const { rows: factures } = await db.query(`
      SELECT
        i.id, i.numero, i.montant_ttc, i.date_echeance, i.client_nom,
        (CURRENT_DATE - i.date_echeance::date)::int  AS jours_retard,
        u.plan, u.prenom, u.nom, u.entreprise,
        c.email  AS client_email,
        c.nom    AS client_nom_full,
        c.risque AS client_risque,
        COALESCE(
          (SELECT JSON_AGG(JSON_BUILD_OBJECT('date', TO_CHAR(r.created_at,'YYYY-MM-DD'), 'ton', r.ton)
             ORDER BY r.created_at)
           FROM relances r WHERE r.invoice_id = i.id),
          '[]'::json
        ) AS historique
      FROM invoices i
      JOIN users    u ON u.id = i.user_id
      LEFT JOIN clients c ON c.id = i.client_id
      WHERE i.statut = 'retard'
        AND u.plan IN ('pro', 'business')
        AND (CURRENT_DATE - i.date_echeance::date) IN (7, 14, 30, 45)
        AND NOT EXISTS (
          SELECT 1 FROM relances r2
          WHERE r2.invoice_id = i.id
            AND r2.created_at::date = CURRENT_DATE
        )
    `);

    results.checked = factures.length;

    for (const f of factures) {
      const jours     = f.jours_retard;
      const tone      = toneFor(jours);
      const clientEmail = f.client_email;

      // ── 2. Guard : pas d'email client → skip silencieux ───────────────────
      if (!clientEmail) { results.skipped++; continue; }

      // ── 3. Vérification live (facture toujours en retard ?) ───────────────
      const { rows: [live] } = await db.query(
        'SELECT statut FROM invoices WHERE id = $1',
        [f.id]
      );
      if (!live || live.statut !== 'retard') { results.skipped++; continue; }

      try {
        // ── 4. Génération IA ─────────────────────────────────────────────────
        const historique = Array.isArray(f.historique) ? f.historique : [];
        const { subject, body } = await generateDunningEmail(
          f.client_nom_full || f.client_nom,
          Number(f.montant_ttc),
          jours,
          tone,
          historique,
          { invoiceNumber: f.numero }
        );

        // ── 5. Envoi email ───────────────────────────────────────────────────
        const htmlBody = `
          <div style="font-family:sans-serif;max-width:560px">
            <div style="background:#1B3A4B;padding:20px 24px;border-radius:10px 10px 0 0">
              <h2 style="color:white;margin:0;font-size:1.05rem">${subject}</h2>
            </div>
            <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 10px 10px">
              <p style="white-space:pre-line;color:#374151">${body}</p>
              <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
              <p style="font-size:.82rem;color:#6b7280">
                ${f.prenom} ${f.nom} — ${f.entreprise}
              </p>
            </div>
          </div>`;

        await sendInvoiceEmail(clientEmail, subject, htmlBody, null, f.numero);

        // ── 6. Log en base ───────────────────────────────────────────────────
        await db.query(
          `INSERT INTO relances (invoice_id, type, ton, message, statut)
           VALUES ($1, 'email', $2, $3, 'envoyée')`,
          [f.id, tone, body.slice(0, 1000)] // tronqué à 1 000 chars pour la DB
        );

        console.log(`[CRON] ✅ Relance ${tone} → ${clientEmail} | facture ${f.numero} | J+${jours}`);
        results.sent++;

      } catch (err) {
        console.error(`[CRON] ❌ Facture ${f.numero} :`, err.message);
        results.errors++;
      }
    }

    return res.json({ ok: true, date: today, ...results });

  } catch (err) {
    console.error('[CRON] Erreur globale :', err.message);
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { runRelances };
