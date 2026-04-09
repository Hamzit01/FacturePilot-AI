'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

const fmt = (c) => ({
  id: String(c.id), userId: c.user_id,
  nom: c.nom, siret: c.siret, email: c.email, tel: c.tel,
  adresse: c.adresse, secteur: c.secteur,
  delaiPaiement: c.delai_paiement, risque: c.risque,
  createdAt: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at,
});

// GET /api/clients
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clients WHERE user_id = $1 ORDER BY nom', [req.user.id]);
    res.json(rows.map(fmt));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const row = (await db.query('SELECT * FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Client introuvable' });
    res.json(fmt(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients
router.post('/', auth, async (req, res) => {
  try {
    const { nom, siret, email, tel, adresse, secteur, delaiPaiement, risque } = req.body;
    if (!nom) return res.status(400).json({ error: 'Le nom est requis' });
    const { rows: [inserted] } = await db.query(`
      INSERT INTO clients (user_id,nom,siret,email,tel,adresse,secteur,delai_paiement,risque)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [req.user.id, nom, siret||'', email||'', tel||'', adresse||'', secteur||'', delaiPaiement||30, risque||'faible']);
    const row = (await db.query('SELECT * FROM clients WHERE id = $1', [inserted.id])).rows[0];
    res.status(201).json(fmt(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/clients/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const existing = (await db.query('SELECT id FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Client introuvable' });
    const { nom, siret, email, tel, adresse, secteur, delaiPaiement, risque } = req.body;
    await db.query(`
      UPDATE clients SET nom=$1,siret=$2,email=$3,tel=$4,adresse=$5,secteur=$6,delai_paiement=$7,risque=$8
      WHERE id=$9 AND user_id=$10
    `, [nom, siret||'', email||'', tel||'', adresse||'', secteur||'', delaiPaiement||30, risque||'faible', req.params.id, req.user.id]);
    const updated = (await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id])).rows[0];
    res.json(fmt(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const existing = (await db.query('SELECT id FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Client introuvable' });
    await db.query('DELETE FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
