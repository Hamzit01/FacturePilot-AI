'use strict';
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const helmet     = require('helmet');
const morgan     = require('morgan');
const compression = require('compression');
const { authLimiter, aiLimiter, globalLimiter } = require('./middlewares/rate-limit');

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

// ─── Request logging sécurisé ───────────────────────────────────────────────���
// En production : format minimal (méthode, URL sanitisée, statut, temps)
// Les champs sensibles (email, password, iban, bic, token) sont masqués dans l'URL
// req.body n'est JAMAIS loggué (Morgan n'y a pas accès par défaut)
if (isProd) {
  // Token Morgan personnalisé : URL sans query params sensibles
  morgan.token('safe-url', (req) => {
    try {
      const SENSITIVE = /[?&](email|password|token|iban|bic|secret|key|code)=[^&]*/gi;
      return req.originalUrl.replace(SENSITIVE, (m, k) => m.replace(/=.*/i, '=[REDACTED]'));
    } catch { return req.originalUrl; }
  });
  // Format : IP - méthode URL status temps
  app.use(morgan(':remote-addr - :method :safe-url :status :res[content-length] - :response-time ms'));
} else {
  app.use(morgan('dev'));
}

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

// ─── Stripe (RAW body — DOIT être avant express.json) ────────────────────────
// /api/stripe/webhook   — legacy (conservé pour compatibilité)
// /api/webhooks/stripe  — webhook principal (switch complet + idempotence)
// /api/stripe/checkout  — création de Checkout Session (live/test auto-switch)
// /api/stripe/prices    — liste des Price IDs actifs
app.use('/api/stripe',   require('./routes/stripe'));
app.use('/api/webhooks', require('./routes/stripe.routes'));
app.use('/api/stripe',   require('./routes/stripe.routes')); // checkout + prices

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));   // 5 MB pour logos base64
app.use(express.urlencoded({ extended: true }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
app.use('/api/auth',                      authLimiter);   // 10 req/15 min — brute-force
app.use('/api/invoices/:id/ai-relance',   aiLimiter);     // 20 req/heure — quota OpenAI
app.use('/api',                           globalLimiter); // 200 req/min — anti-flood

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/me',       require('./routes/user'));
app.use('/api/clients',  require('./routes/clients'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/cron',    require('./routes/cron'));          // legacy POST (conservé)
app.use('/api/cron',    require('./routes/cron.routes'));   // GET /api/cron/relances (Vercel)

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
// En production : les stack traces sont loguées sans les champs sensibles
const SENSITIVE_KEYS = /\b(password|password_hash|iban|bic|token|secret|key|authorization)\b/gi;
const sanitizeForLog = (obj) => {
  if (!obj) return obj;
  try {
    return JSON.stringify(obj).replace(SENSITIVE_KEYS, '[REDACTED]');
  } catch { return '[non-sérialisable]'; }
};

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    // Log l'erreur sans les champs sensibles
    const msg = isProd ? sanitizeForLog(err.message) : (err.stack || err.message);
    console.error('[ERROR]', msg);
  }
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
    console.log(`🔒  Mode : ${isProd ? 'PRODUCTION' : 'développement'}\n`);
  });
}

module.exports = app;
