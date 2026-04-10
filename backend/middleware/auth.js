'use strict';
require('dotenv').config();
const jwt = require('jsonwebtoken');
if (!process.env.JWT_SECRET) {
  console.error('[AUTH] ERREUR CRITIQUE : JWT_SECRET non défini dans les variables d\'environnement !');
}
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

module.exports = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
};

module.exports.JWT_SECRET = JWT_SECRET;
module.exports.sign = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
