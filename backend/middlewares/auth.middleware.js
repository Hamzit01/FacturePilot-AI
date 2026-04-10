'use strict';
/**
 * requireAuth  — vérifie le JWT Bearer et injecte req.user = { id, email }
 * requireOwner — helper IDOR : charge une ressource en DB avec WHERE id=$1 AND user_id=$2
 *                et l'injecte dans req.resource (ou renvoie 403/404)
 */
const jwt = require('jsonwebtoken');
const db  = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[AUTH] FATAL: JWT_SECRET non défini');
  process.exit(1);
}

// ── 1. Vérification JWT ──────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'Token manquant' });

  try {
    req.user = jwt.verify(token, JWT_SECRET); // { id, email, iat, exp }
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expiré' : 'Token invalide';
    return res.status(401).json({ error: msg });
  }
};

// ── 2. Isolation tenant (IDOR guard) ────────────────────────────────────────
/**
 * requireOwner(table, pkParam = 'id')
 *
 * Middleware factory : exécute
 *   SELECT * FROM <table> WHERE id = $1 AND user_id = $2
 * Si la ligne n'existe pas ou appartient à un autre user → 404 (pas 403,
 * pour ne pas révéler l'existence de la ressource).
 * Sinon → injecte req.resource et appelle next().
 *
 * Usage dans une route :
 *   router.get('/:id', requireAuth, requireOwner('invoices'), (req, res) => {
 *     res.json(req.resource);
 *   });
 */
const requireOwner = (table, pkParam = 'id') => async (req, res, next) => {
  const resourceId = parseInt(req.params[pkParam], 10);
  if (!Number.isInteger(resourceId) || resourceId <= 0) {
    return res.status(400).json({ error: 'Identifiant invalide' });
  }

  try {
    const { rows } = await db.query(
      // Clause stricte : id ET user_id — le moteur peut utiliser un index composite (id, user_id)
      `SELECT * FROM ${table} WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [resourceId, req.user.id]
    );

    if (!rows.length) {
      // Répondre 404 même si la ressource existe mais appartient à un autre tenant
      return res.status(404).json({ error: 'Ressource introuvable' });
    }

    req.resource = rows[0];
    next();
  } catch (err) {
    console.error(`[requireOwner:${table}]`, err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { requireAuth, requireOwner };
