'use strict';
/**
 * Vercel Cron Jobs — vercel.json config requise :
 *
 *   {
 *     "crons": [{
 *       "path": "/api/cron/relances",
 *       "schedule": "0 8 * * *"
 *     }]
 *   }
 *
 * Vercel injecte automatiquement :
 *   Authorization: Bearer <CRON_SECRET>
 *
 * ⚠️ Vercel Cron exige GET (pas POST)
 */
const express = require('express');
const { requireCronSecret } = require('../middlewares/cron.middleware');
const { runRelances }       = require('../controllers/cron.controller');

const router = express.Router();

// GET /api/cron/relances
router.get('/relances', requireCronSecret, runRelances);

module.exports = router;
