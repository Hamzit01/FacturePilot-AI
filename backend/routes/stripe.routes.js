'use strict';
/**
 * Stripe routes — webhooks + checkout session
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/webhooks/stripe — réception des events Stripe (RAW body obligatoire)
 * POST /api/stripe/checkout  — crée une Checkout Session et renvoie l'URL
 *
 * ⚠️ Monter AVANT express.json() dans server.js
 */
const express = require('express');
const db      = require('../db');
const auth    = require('../middleware/auth');
const router  = express.Router();

// ── Résolution des Price IDs live vs test ────────────────────────────────────
// Variables d'environnement attendues :
//   STRIPE_PRICE_PRO_LIVE      / STRIPE_PRICE_PRO_TEST
//   STRIPE_PRICE_BUSINESS_LIVE / STRIPE_PRICE_BUSINESS_TEST
//   STRIPE_SUCCESS_URL         (ex: https://facturepilot.ai/dashboard.html?upgraded=1)
//   STRIPE_CANCEL_URL          (ex: https://facturepilot.ai/settings.html)
const isLive = () => process.env.NODE_ENV === 'production' &&
                     process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_');

const PRICE_IDS = {
  pro: () => isLive()
    ? process.env.STRIPE_PRICE_PRO_LIVE
    : process.env.STRIPE_PRICE_PRO_TEST,
  business: () => isLive()
    ? process.env.STRIPE_PRICE_BUSINESS_LIVE
    : process.env.STRIPE_PRICE_BUSINESS_TEST,
};

// ── POST /api/stripe/checkout — crée une session Checkout ───────────────────
// Corps : { plan: 'pro' | 'business' }
// Retour : { url: 'https://checkout.stripe.com/...' }
router.post('/checkout', auth, express.json(), async (req, res) => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(503).json({ error: 'Stripe non configuré' });

  const plan = (req.body.plan || '').toLowerCase().trim();
  if (!['pro', 'business'].includes(plan)) {
    return res.status(400).json({ error: 'Plan invalide : "pro" ou "business" attendu' });
  }

  const priceId = PRICE_IDS[plan]?.();
  if (!priceId) {
    return res.status(503).json({
      error: `Price ID manquant pour le plan "${plan}" en mode ${isLive() ? 'live' : 'test'}`,
    });
  }

  try {
    const stripe  = require('stripe')(secretKey, { apiVersion: '2024-06-20' });
    const { rows: [user] } = await db.query('SELECT email, stripe_customer FROM users WHERE id=$1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { plan, user_id: String(req.user.id) },
      success_url: process.env.STRIPE_SUCCESS_URL ||
        'https://facturepilot-ai-beta111.vercel.app/dashboard.html?upgraded=1',
      cancel_url: process.env.STRIPE_CANCEL_URL ||
        'https://facturepilot-ai-beta111.vercel.app/settings.html',
      // Pré-remplir l'email si déjà connu
      customer_email: user.stripe_customer ? undefined : user.email,
      customer: user.stripe_customer || undefined,
      // Facturation FR — conformité TVA
      billing_address_collection: 'required',
      locale: 'fr',
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`[Stripe] Checkout session créée — plan "${plan}" | user ${req.user.id} | ${isLive() ? 'LIVE' : 'test'}`);
    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[Stripe Checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stripe/prices — retourne les Price IDs actifs (pour le frontend) ─
// Ne retourne que les IDs, pas les secrets
router.get('/prices', (_req, res) => {
  const mode = isLive() ? 'live' : 'test';
  res.json({
    mode,
    pro:      PRICE_IDS.pro()      || null,
    business: PRICE_IDS.business() || null,
  });
});

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
