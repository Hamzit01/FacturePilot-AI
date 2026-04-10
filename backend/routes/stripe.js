'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ─── POST /api/stripe/webhook ─────────────────────────────────────────────────
// Corps RAW obligatoire pour la vérification de signature Stripe
// → ce endpoint doit être enregistré AVANT express.json() dans server.js
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secretKey     = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    console.error('[Stripe] STRIPE_SECRET_KEY ou STRIPE_WEBHOOK_SECRET manquants');
    return res.status(500).json({ error: 'Configuration Stripe manquante' });
  }

  const stripe = require('stripe')(secretKey);
  const sig    = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe] Signature invalide :', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Idempotency : ignorer les events déjà traités
  try {
    await db.query('INSERT INTO stripe_events (event_id) VALUES ($1)', [event.id]);
  } catch(dupErr) {
    // Clé dupliquée = event déjà traité
    console.log('[Stripe] Event déjà traité, ignoré :', event.id);
    return res.json({ received: true });
  }

  // ── Paiement réussi ──────────────────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email   = (session.customer_email || session.customer_details?.email || '').toLowerCase().trim();

    if (!email) {
      console.warn('[Stripe] Aucun email dans la session :', session.id);
      return res.json({ received: true });
    }

    // Détection du plan : metadata en priorité, montant en fallback
    let plan = (session.metadata?.plan || '').toLowerCase();
    if (!plan) {
      const cents = session.amount_total || 0;
      if      (cents >= 4500) plan = 'business';
      else if (cents >= 1500) plan = 'pro';
    }

    if (!plan) {
      console.warn('[Stripe] Plan non identifié — session :', session.id, '| montant :', session.amount_total);
      return res.json({ received: true });
    }

    // Mise à jour en base
    try {
      const result = await db.query(
        'UPDATE users SET plan = $1 WHERE email = $2 RETURNING id, prenom',
        [plan, email]
      );

      if (result.rowCount > 0) {
        const user = result.rows[0];
        console.log(`[Stripe] ✅ Plan "${plan}" activé pour ${email} (id:${user.id})`);

        // Email de confirmation
        const { sendMail } = require('../services/mailer');
        const labels = { pro: 'Pro — 29 €/mois', business: 'Business — 49 €/mois' };
        const features = {
          pro:      ['✓ 100 factures/mois', '✓ Relances IA email + SMS', '✓ 2 utilisateurs', '✓ Support prioritaire'],
          business: ['✓ Factures illimitées', '✓ Scoring client risque', '✓ Mise en demeure auto', '✓ 5 utilisateurs', '✓ Support téléphonique'],
        };
        sendMail({
          to:      email,
          subject: `🎉 Plan ${labels[plan]} activé — FacturePilot AI`,
          html: `
          <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto">
            <div style="background:#1B3A4B;padding:24px 28px;border-radius:10px 10px 0 0">
              <h2 style="color:white;margin:0;font-size:1.3rem">FacturePilot AI</h2>
              <div style="color:rgba(255,255,255,.65);font-size:.9rem;margin-top:4px">Confirmation d'abonnement</div>
            </div>
            <div style="border:1px solid #e5e7eb;border-top:none;padding:28px;border-radius:0 0 10px 10px">
              <p style="color:#374151">Bonjour ${user.prenom || ''},</p>
              <p style="color:#374151">Votre abonnement <strong>${labels[plan]}</strong> est actif ! 🚀</p>
              <div style="background:#f9fafb;border-radius:8px;padding:16px 20px;margin:16px 0">
                <div style="font-size:.88rem;font-weight:700;color:#1B3A4B;margin-bottom:10px">Fonctionnalités débloquées :</div>
                ${(features[plan] || []).map(f => `<div style="font-size:.88rem;color:#374151;padding:3px 0">${f}</div>`).join('')}
              </div>
              <div style="text-align:center;margin:24px 0">
                <a href="https://facturepilot-ai-beta111.vercel.app/dashboard.html"
                   style="background:#1B3A4B;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
                  Accéder à mon espace →
                </a>
              </div>
              <p style="color:#6b7280;font-size:.82rem">Pour toute question : <a href="mailto:contact@facturepilot.ai" style="color:#1B3A4B">contact@facturepilot.ai</a></p>
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0"/>
              <p style="font-size:.76rem;color:#9ca3af;text-align:center">FacturePilot AI · Résiliez à tout moment depuis vos paramètres</p>
            </div>
          </div>`,
        }).catch(err => console.error('[Stripe] Email confirmation :', err.message));

      } else {
        console.warn(`[Stripe] Aucun compte trouvé pour l'email : ${email}`);
      }
    } catch (err) {
      console.error('[Stripe] Erreur DB :', err.message);
    }
  }

  // Toujours répondre 200 à Stripe même si rien ne correspond
  res.json({ received: true });
});

// POST /api/stripe/portal — Stripe Customer Portal (self-service abonnement)
router.post('/portal', require('../middleware/auth'), async (req, res) => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'STRIPE_SECRET_KEY manquant' });
  try {
    const stripe = require('stripe')(secretKey);
    const user = (await db.query('SELECT email FROM users WHERE id=$1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    // Chercher le customer Stripe par email
    const customers = await stripe.customers.list({ email: user.email.toLowerCase(), limit: 1 });
    if (!customers.data.length) {
      return res.status(404).json({ error: 'Aucun abonnement Stripe trouvé pour ce compte.' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: process.env.APP_URL || 'https://facturepilot-ai-beta111.vercel.app/settings.html',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe Portal]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
