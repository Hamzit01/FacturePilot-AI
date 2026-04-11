'use strict';
/**
 * requireCronSecret
 * ─────────────────────────────────────────────────────────────────────────────
 * Vercel Cron Jobs envoie automatiquement :
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Fail-closed : si CRON_SECRET n'est pas configuré en env, l'endpoint
 * retourne 503 plutôt que de s'exécuter sans protection.
 *
 * Résistance au timing-attack : comparaison en temps constant via
 * crypto.timingSafeEqual (même longueur forcée par padding).
 */
const { timingSafeEqual } = require('crypto');

const requireCronSecret = (req, res, next) => {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error('[CRON] CRON_SECRET non défini — endpoint désactivé');
    return res.status(503).json({ error: 'Cron non configuré' });
  }

  // Header Authorization: Bearer UNIQUEMENT — query params visibles dans les logs
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  const provided = authHeader.slice(7).trim();

  // timingSafeEqual requiert des buffers de même longueur
  const a = Buffer.alloc(64, 0);
  const b = Buffer.alloc(64, 0);
  Buffer.from(provided).copy(a);
  Buffer.from(secret).copy(b);

  if (!timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  next();
};

module.exports = { requireCronSecret };
