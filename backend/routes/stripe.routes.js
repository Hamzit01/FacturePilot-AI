'use strict';
/**
 * POST /api/webhooks/stripe
 * ─────────────────────────────────────────────────────────────────────────────
 * DOIT être monté AVANT express.json() dans server.js :
 *   app.use('/api/webhooks', require('./routes/stripe.routes'));
 *
 * Le middleware express.raw() est appliqué ici directement sur la route,
 * ce qui évite d'affecter le parsing JSON des autres routes.
 */
const express = require('express');
const db      = require('../db');
const router  = express.Router();

// Plan → label lisible
const PLAN_LABELS = {
  pro:      'Pro — 29 €/mois',
  business: 'Business — 49 €/mois',
};

// Détecte le plan depuis les metadata Stripe ou en fallback sur le montant
const resolvePlan = (session) => {
  const fromMeta = (session.metadata?.plan || '').toLowerCase().trim();
  if (PLAN_LABELS[fromMeta]) return fromMeta;

  const cents = session.amount_total || 0;
  if (cents >= 4500) return 'business';
  if (cents >= 1500) return 'pro';
  return null;
};

router.post(
  '/stripe',
  // ⚠️ RAW body obligatoire : express.raw doit précéder toute désérialisation JSON
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const secretKey     = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // Fail-closed : refuser si les clés sont absentes
    if (!secretKey || !webhookSecret) {
      console.error('[Stripe] Variables d\'environnement manquantes');
      return res.status(503).json({ error: 'Configuration Stripe manquante' });
    }

    // ── 1. Vérification de signature ──────────────────────────────────────────
    const stripe = require('stripe')(secretKey, { apiVersion: '2024-06-20' });
    const sig    = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      // Signature invalide → attaque potentielle ou mauvaise config
      console.warn('[Stripe] Signature invalide :', err.message);
      return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
    }

    // ── 2. Idempotence : ignorer les events déjà traités ──────────────────────
    try {
      await db.query(
        'INSERT INTO stripe_events (event_id) VALUES ($1)',
        [event.id]
      );
    } catch {
      // Contrainte UNIQUE → event déjà traité
      return res.json({ received: true });
    }

    // ── 3. Dispatch des événements ────────────────────────────────────────────
    switch (event.type) {

      // ── Paiement initial / upgrade ──────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email   = (
          session.customer_email ||
          session.customer_details?.email ||
          ''
        ).toLowerCase().trim();

        if (!email) {
          console.warn('[Stripe] checkout.session.completed sans email :', session.id);
          break;
        }

        const plan = resolvePlan(session);
        if (!plan) {
          console.warn('[Stripe] Plan non identifié :', session.id, session.amount_total);
          break;
        }

        const { rowCount, rows } = await db.query(
          `UPDATE users
              SET plan              = $1,
                  stripe_customer   = COALESCE(stripe_customer, $3),
                  updated_at        = NOW()
            WHERE email = $2
            RETURNING id, prenom`,
          [plan, email, session.customer ?? null]
        );

        if (rowCount === 0) {
          console.warn('[Stripe] Aucun compte pour :', email);
          break;
        }

        console.log(`[Stripe] ✅ Plan "${plan}" → ${email} (id:${rows[0].id})`);
        break;
      }

      // ── Abonnement résilié / suspendu ───────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub      = event.data.object;
        const custId   = sub.customer;

        await db.query(
          `UPDATE users
              SET plan = 'essentiel', updated_at = NOW()
            WHERE stripe_customer = $1`,
          [custId]
        );

        console.log(`[Stripe] Abonnement supprimé → downgrade essentiel (customer:${custId})`);
        break;
      }

      // ── Renouvellement récurrent ─────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const inv    = event.data.object;
        const custId = inv.customer;

        // Prolonger la validité du plan (idempotent)
        await db.query(
          `UPDATE users SET updated_at = NOW() WHERE stripe_customer = $1`,
          [custId]
        );
        break;
      }

      // ── Paiement échoué ──────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const inv    = event.data.object;
        const custId = inv.customer;
        console.warn(`[Stripe] Paiement échoué pour customer: ${custId}`);
        // À enrichir : envoyer un email d'alerte + flag en DB si nécessaire
        break;
      }

      default:
        // Event non géré — log en dev uniquement
        if (process.env.NODE_ENV !== 'production') {
          console.log('[Stripe] Event ignoré :', event.type);
        }
    }

    // Toujours répondre 200 à Stripe pour acquitter la réception
    return res.json({ received: true });
  }
);

module.exports = router;
