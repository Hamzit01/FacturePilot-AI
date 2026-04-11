'use strict';
const express = require('express');
const { requireCronSecret } = require('../middlewares/cron.middleware');
const router  = express.Router();

// POST /api/cron/relances — legacy endpoint (conservé pour compatibilité outils externes)
// Sécurisé par requireCronSecret (Authorization: Bearer CRON_SECRET uniquement)
router.post('/relances', requireCronSecret, async (req, res) => {

  const today = new Date().toISOString().split('T')[0];
  const { sendMail } = require('../services/mailer');
  const db = require('../db');

  // Factures en retard depuis 7, 14 ou 30 jours sans relance récente
  const { rows: factures } = await db.query(`
    SELECT i.*, u.email as user_email, u.prenom, u.nom, u.entreprise, u.tel,
           c.email as client_email, c.nom as client_nom_contact,
           CURRENT_DATE - i.date_echeance::date AS jours_retard
    FROM invoices i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN clients c ON c.id = i.client_id
    WHERE i.statut = 'retard'
      AND (CURRENT_DATE - i.date_echeance::date) IN (7, 14, 30)
      AND i.id NOT IN (
        SELECT invoice_id FROM relances
        WHERE created_at > NOW() - INTERVAL '5 days'
      )
  `);

  let sent = 0;
  for (const f of factures) {
    const joursRetard = parseInt(f.jours_retard);
    const ton   = joursRetard >= 30 ? 'ferme' : 'cordial';
    const sujet = joursRetard >= 30
      ? `⚠️ Dernier rappel — Facture ${f.numero} impayée depuis ${joursRetard} jours`
      : `Rappel — Facture ${f.numero} en attente de règlement`;

    const montant  = Number(f.montant_ttc).toLocaleString('fr-FR', { minimumFractionDigits: 2 });
    const echeance = new Date(f.date_echeance).toLocaleDateString('fr-FR');
    const clientEmail = f.client_email;

    if (!clientEmail) continue;

    // Vérification live : la facture est-elle toujours en retard ?
    const { rows: [live] } = await db.query('SELECT statut FROM invoices WHERE id=$1', [f.id]);
    if (!live || live.statut !== 'retard') continue;

    const message = joursRetard >= 30
      ? `Malgré nos précédentes relances, votre facture ${f.numero} d'un montant de ${montant} € TTC reste impayée depuis ${joursRetard} jours (échéance : ${echeance}). Sans règlement sous 8 jours, nous serons contraints d'engager une procédure de recouvrement.`
      : `Sauf erreur de notre part, votre facture ${f.numero} d'un montant de ${montant} € TTC était à régler le ${echeance}. Pourriez-vous procéder au règlement dans les meilleurs délais ?`;

    try {
      await sendMail({
        to: clientEmail,
        subject: sujet,
        html: `<div style="font-family:sans-serif;max-width:520px">
          <div style="background:#1B3A4B;padding:20px 24px;border-radius:10px 10px 0 0">
            <h2 style="color:white;margin:0;font-size:1.1rem">${sujet}</h2>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 10px 10px">
            <p>Bonjour ${f.client_nom_contact || f.client_nom || 'Madame, Monsieur'},</p>
            <p>${message}</p>
            <div style="background:#f4f7fa;border-radius:8px;padding:14px 18px;margin:16px 0">
              <strong>Facture :</strong> ${f.numero}<br/>
              <strong>Montant TTC :</strong> ${montant} €<br/>
              <strong>Échéance :</strong> ${echeance}<br/>
              <strong>Retard :</strong> ${joursRetard} jours
            </div>
            <p>Cordialement,<br/><strong>${f.prenom} ${f.nom}</strong><br/>${f.entreprise}${f.tel ? '<br/>' + f.tel : ''}</p>
          </div>
        </div>`,
        text: message,
      });

      // Enregistrer la relance en base
      await db.query(
        "INSERT INTO relances (invoice_id, type, ton, message, statut) VALUES ($1, 'email', $2, $3, 'envoyée')",
        [f.id, ton, message]
      );
      sent++;
    } catch (e) {
      console.error(`[CRON] Erreur relance facture ${f.numero}:`, e.message);
    }
  }

  res.json({ ok: true, checked: factures.length, sent, date: today });
});

module.exports = router;
