'use strict';
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const helmet     = require('helmet');
const morgan     = require('morgan');
const compression = require('compression');
const rateLimit  = require('express-rate-limit');

// ─── Init DB (runs schema + migration + seed on first launch) ────────────────
const db = require('./db');

const app  = express();
const PORT = process.env.PORT || 3333;
const isProd = process.env.NODE_ENV === 'production';

// ─── Security headers (Helmet) ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,    // disabled — inline scripts in HTML pages
  crossOriginEmbedderPolicy: false,
}));

// ─── Compression ─────────────────────────────────────────────────────────────
app.use(compression());

// ─── Health check (sync — répond toujours immédiatement) ─────────────────────
app.get('/api/health', (_req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    version: require('./package.json').version,
    database: dbUrl ? `✅ DATABASE_URL défini (${dbUrl.split('@')[1] || 'ok'})` : '❌ DATABASE_URL manquant',
    node: process.version,
  });
});

// ─── DB ready middleware — UNIQUEMENT pour les routes /api ───────────────────
// Les fichiers statiques (HTML/CSS/JS) sont toujours servis, même si la DB est down
app.use('/api', async (req, res, next) => {
  try {
    await db.ready;
    next();
  } catch(err) {
    res.status(503).json({ error: 'Base de données non disponible', details: err.message });
  }
});

// ─── Request logging ─────────────────────────────────────────────────────────
app.use(morgan(isProd ? 'combined' : 'dev'));

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null; // null = pas de restriction (dev + Vercel same-origin)

app.use(cors({
  origin: (origin, cb) => {
    // Pas de restriction si ALLOWED_ORIGINS non configuré (dev / Vercel)
    if (!allowedOrigins) return cb(null, true);
    // Autoriser les requêtes sans origin (mobile, curl, same-origin)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origine non autorisée : ${origin}`));
  },
  credentials: true,
}));

// ─── Stripe webhook (RAW body — DOIT être avant express.json) ────────────────
// Stripe envoie un corps brut signé ; express.json() le détruirait avant vérification
app.use('/api/stripe', require('./routes/stripe'));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));   // 5 MB pour logos base64
app.use(express.urlencoded({ extended: true }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Auth routes — strict (brute-force protection)
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
}));

// Global API limiter — generous but prevents abuse
app.use('/api', rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, veuillez ralentir' },
}));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/me',       require('./routes/user'));
app.use('/api/clients',  require('./routes/clients'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/cron',    require('./routes/cron'));

// ─── Static files (frontend) ─────────────────────────────────────────────────
const STATIC_DIR = path.join(__dirname, '..');
app.use(express.static(STATIC_DIR, {
  index: 'index.html',
  maxAge: isProd ? '1d' : 0,
  etag: true,
}));

// SPA fallback — serve index.html for non-API routes
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[ERROR]', err.stack || err.message);
  // En production : ne jamais exposer les internals DB (noms de tables, contraintes, colonnes)
  let message = err.message || 'Erreur serveur';
  if (isProd && status >= 500) {
    message = 'Une erreur interne est survenue. Notre équipe a été notifiée.';
  } else if (isProd) {
    // Masquer les détails PostgreSQL (ex: "duplicate key value violates unique constraint...")
    const pgPatterns = [/column\s+"[\w_]+"/i, /relation\s+"[\w_]+"/i, /constraint\s+"[\w_]+"/i, /syntax error at/i, /ERROR:\s+/i];
    if (pgPatterns.some(p => p.test(message))) {
      message = 'Opération invalide. Veuillez vérifier vos données.';
    }
  }
  res.status(status).json({ error: message });
});

// ─── Start (local) / Export (Vercel) ─────────────────────────────────────────
// Sur Vercel, la fonction est invoquée directement — pas de app.listen()
if (!process.env.VERCEL && require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n✅  FacturePilot AI — Backend opérationnel`);
    console.log(`🌐  http://localhost:${PORT}`);
    console.log(`🔒  Mode : ${isProd ? 'PRODUCTION' : 'développement'}`);
    console.log(`📧  Démo : hamza@facturepilot.ai / demo1234\n`);
  });
}

module.exports = app;
