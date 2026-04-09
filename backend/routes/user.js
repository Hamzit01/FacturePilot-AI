'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

const sanitize = (u) => ({
  id: u.id, prenom: u.prenom, nom: u.nom, email: u.email,
  entreprise: u.entreprise, siren: u.siren, tva: u.tva_num,
  adresse: u.adresse, tel: u.tel, iban: u.iban, bic: u.bic,
  plan: u.plan, couleurFacture: u.couleur_facture, logo: u.logo,
  createdAt: u.created_at,
});

// GET /api/me
router.get('/', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(sanitize(user));
});

// PUT /api/me
router.put('/', auth, (req, res) => {
  const { prenom, nom, entreprise, siren, tva, adresse, tel, iban, bic, couleurFacture, logo } = req.body;
  db.prepare(`
    UPDATE users SET prenom=?, nom=?, entreprise=?, siren=?, tva_num=?,
      adresse=?, tel=?, iban=?, bic=?, couleur_facture=?, logo=?
    WHERE id=?
  `).run(prenom, nom, entreprise, siren, tva, adresse, tel, iban, bic, couleurFacture, logo, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(sanitize(user));
});

// GET /api/me/stats  — dashboard KPIs
router.get('/stats', auth, (req, res) => {
  const uid = req.user.id;
  const invs = db.prepare('SELECT * FROM invoices WHERE user_id = ?').all(uid);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

  const caMonth   = invs.filter(i => i.date_emission >= monthStart).reduce((s,i) => s + i.montant_ttc, 0);
  const encours   = invs.filter(i => ['envoyee','retard'].includes(i.statut)).reduce((s,i) => s + i.montant_ttc, 0);
  const retard    = invs.filter(i => i.statut === 'retard').reduce((s,i) => s + i.montant_ttc, 0);
  const retardCount = invs.filter(i => i.statut === 'retard').length;
  const payees    = invs.filter(i => i.statut === 'payee').reduce((s,i) => s + i.montant_ttc, 0);
  const total     = invs.reduce((s,i) => s + i.montant_ttc, 0);
  const taux      = total > 0 ? Math.round(payees / total * 100) : 0;

  res.json({ caMonth, encours, retard, retardCount, tauxRecouvrement: taux, totalInvoices: invs.length });
});

// POST /api/me/change-password — change le mot de passe
router.post('/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Les deux mots de passe sont requis' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const ok = bcrypt.compareSync(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  res.json({ ok: true, message: 'Mot de passe mis à jour avec succès' });
});

// DELETE /api/me — supprime le compte et toutes les données
router.delete('/', auth, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  res.json({ ok: true, message: 'Compte supprimé' });
});

// POST /api/me/test-email — vérifie la connexion SMTP et envoie un email de test
router.post('/test-email', auth, async (req, res) => {
  const { sendMail, testConnection } = require('../services/mailer');
  const conn = await testConnection();
  if (!conn.ok) return res.status(400).json({ error: conn.message });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  try {
    await sendMail({
      to: user.email,
      subject: '✅ Test FacturePilot AI — configuration email OK',
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#1B3A4B">FacturePilot AI</h2>
        <p>Bonjour <strong>${user.prenom}</strong>,</p>
        <p>Votre configuration email est opérationnelle. Les relances automatiques et notifications seront envoyées depuis cette adresse.</p>
        <p style="color:#6b7a8a;font-size:.85em">FacturePilot AI — ${new Date().toLocaleString('fr-FR')}</p>
      </div>`,
    });
    res.json({ ok: true, message: `Email de test envoyé à ${user.email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
