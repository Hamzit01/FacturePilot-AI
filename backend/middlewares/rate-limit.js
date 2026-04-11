'use strict';
/**
 * Instances rate-limit réutilisables
 * Montées dans server.js AVANT les routes concernées
 */
const rateLimit = require('express-rate-limit');

// ── Auth : protection brute-force ─────────────────────────────────────────────
// 10 req / 15 min par IP — strict volontairement (risque compte compromis)
const authLimiter = rateLimit({
  windowMs:       15 * 60 * 1000, // 15 minutes
  max:            10,
  standardHeaders: true,
  legacyHeaders:  false,
  skipSuccessfulRequests: false,   // compter même les 200 (évite l'enum valide)
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  keyGenerator: (req) => req.ip,   // isoler par IP strictement
});

// ── IA : protection quota OpenAI ─────────────────────────────────────────────
// 20 req / heure par IP — coût estimé ~0.003 $ / appel gpt-4o-mini
// 20 appels max = ~0.06 $ / IP / heure (acceptable)
const aiLimiter = rateLimit({
  windowMs:       60 * 60 * 1000, // 1 heure
  max:            20,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Quota IA atteint. Réessayez dans une heure.' },
  keyGenerator: (req) => req.ip,
  // Exclure les erreurs serveur du compteur (évite de bloquer sur bug 500)
  skip: (req, res) => res && res.statusCode >= 500,
});

// ── Global API : anti-flood général ──────────────────────────────────────────
// 200 req / min — inchangé, protège contre les scrapers
const globalLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            200,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Trop de requêtes, veuillez ralentir.' },
});

module.exports = { authLimiter, aiLimiter, globalLimiter };
