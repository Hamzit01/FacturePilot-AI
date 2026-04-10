// ENCRYPTION_KEY: générer avec: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const db = require('../db');
const auth = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/crypto');

const router = express.Router();

const sanitize = (u) => ({
  id: u.id, prenom: u.prenom, nom: u.nom, email: u.email,
  entreprise: u.entreprise, siren: u.siren, tva: u.tva_num,
  adresse: u.adresse, tel: u.tel, iban: decrypt(u.iban), bic: decrypt(u.bic),
  plan: u.plan, couleurFacture: u.couleur_facture, logo: u.logo,
  createdAt: u.created_at instanceof Date ? u.created_at.toISOString() : u.created_at,
});

// GET /api/me
router.get('/', auth, async (req, res) => {
  try {
    const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json(sanitize(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/me
router.put('/', auth, async (req, res) => {
  try {
    const { prenom, nom, entreprise, siren, tva, adresse, tel, iban, bic, couleurFacture, logo } = req.body;
    // Fetch current values as fallback so undefined fields don't NULL-out existing data
    const current = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0] || {};
    const safeIban = (iban !== undefined) ? encrypt(iban) : current.iban;
    const safeBic  = (bic  !== undefined) ? encrypt(bic)  : current.bic;
    await db.query(`
      UPDATE users SET prenom=$1, nom=$2, entreprise=$3, siren=$4, tva_num=$5,
        adresse=$6, tel=$7, iban=$8, bic=$9, couleur_facture=$10, logo=$11
      WHERE id=$12
    `, [
      prenom      ?? current.prenom       ?? '',
      nom         ?? current.nom          ?? '',
      entreprise  ?? current.entreprise   ?? '',
      siren       ?? current.siren        ?? '',
      tva         ?? current.tva_num      ?? '',
      adresse     ?? current.adresse      ?? '',
      tel         ?? current.tel          ?? '',
      safeIban,
      safeBic,
      couleurFacture ?? current.couleur_facture ?? '#1B3A4B',
      logo !== undefined ? logo : current.logo,
      req.user.id,
    ]);
    const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    res.json(sanitize(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/me/stats  — dashboard KPIs
router.get('/stats', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { rows: invs } = await db.query('SELECT * FROM invoices WHERE user_id = $1', [uid]);
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/me/change-password — change le mot de passe
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Les deux mots de passe sont requis' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères' });

    const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const ok = bcrypt.compareSync(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

    const newHash = bcrypt.hashSync(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
    res.json({ ok: true, message: 'Mot de passe mis à jour avec succès' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/me — supprime le compte et toutes les données
router.delete('/', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, message: 'Compte supprimé' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/me/siren/:siren — lookup entreprise
router.get('/siren/:siren', auth, async (req, res) => {
  const { siren } = req.params;
  if (!/^\d{9}$/.test(siren)) return res.status(400).json({ error: 'SIREN invalide (9 chiffres requis)' });
  try {
    const resp = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${siren}&page=1&per_page=1`);
    const data = await resp.json();
    const result = data.results?.[0];
    if (!result) return res.status(404).json({ error: 'Entreprise non trouvée' });
    res.json({
      siren: result.siren,
      nom: result.nom_complet || result.nom_raison_sociale,
      adresse: [result.siege?.adresse, result.siege?.code_postal, result.siege?.libelle_commune].filter(Boolean).join(', '),
      activite: result.activite_principale,
    });
  } catch(err) {
    res.status(502).json({ error: 'Erreur API Sirene', details: err.message });
  }
});

// POST /api/me/test-email — vérifie la connexion SMTP et envoie un email de test
router.post('/test-email', auth, async (req, res) => {
  try {
    const { sendMail, testConnection } = require('../services/mailer');
    const conn = await testConnection();
    if (!conn.ok) return res.status(400).json({ error: conn.message });
    const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
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
