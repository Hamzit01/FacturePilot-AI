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
  createdAt: c.created_at,
});

// GET /api/clients
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM clients WHERE user_id = ? ORDER BY nom').all(req.user.id);
  res.json(rows.map(fmt));
});

// GET /api/clients/:id
router.get('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Client introuvable' });
  res.json(fmt(row));
});

// POST /api/clients
router.post('/', auth, (req, res) => {
  const { nom, siret, email, tel, adresse, secteur, delaiPaiement, risque } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom est requis' });
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO clients (user_id,nom,siret,email,tel,adresse,secteur,delai_paiement,risque)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.user.id, nom, siret||'', email||'', tel||'', adresse||'', secteur||'', delaiPaiement||30, risque||'faible');
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(lastInsertRowid);
  res.status(201).json(fmt(row));
});

// PUT /api/clients/:id
router.put('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Client introuvable' });
  const { nom, siret, email, tel, adresse, secteur, delaiPaiement, risque } = req.body;
  db.prepare(`
    UPDATE clients SET nom=?,siret=?,email=?,tel=?,adresse=?,secteur=?,delai_paiement=?,risque=?
    WHERE id=? AND user_id=?
  `).run(nom, siret||'', email||'', tel||'', adresse||'', secteur||'', delaiPaiement||30, risque||'faible', req.params.id, req.user.id);
  const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  res.json(fmt(updated));
});

// DELETE /api/clients/:id
router.delete('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Client introuvable' });
  db.prepare('DELETE FROM clients WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
