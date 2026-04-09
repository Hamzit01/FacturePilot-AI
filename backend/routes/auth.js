'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sign } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

  const token = sign({ id: user.id, email: user.email });
  res.json({ token, user: sanitize(user) });
});

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { email, password, prenom, nom, entreprise, siren } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 chars min)' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

  const hash = bcrypt.hashSync(password, 10);
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (email, password_hash, prenom, nom, entreprise, siren)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email.toLowerCase().trim(), hash, prenom || '', nom || '', entreprise || '', siren || '');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  const token = sign({ id: user.id, email: user.email });
  res.status(201).json({ token, user: sanitize(user) });
});

const sanitize = (u) => ({
  id: u.id, prenom: u.prenom, nom: u.nom, email: u.email,
  entreprise: u.entreprise, siren: u.siren, tva: u.tva_num,
  adresse: u.adresse, tel: u.tel, iban: u.iban, bic: u.bic,
  plan: u.plan, couleurFacture: u.couleur_facture, logo: u.logo,
  createdAt: u.created_at,
});

// ─── Mot de passe oublié ────────────────────────────────────────────────────
// Stockage en mémoire : { email → { code, expires } }
const resetTokens = new Map();

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  // On répond toujours avec succès pour ne pas divulguer les emails existants
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 chiffres
  const expires = Date.now() + 15 * 60 * 1000; // 15 minutes

  if (user) {
    resetTokens.set(email.toLowerCase().trim(), { code, expires });
    // Envoi email si SMTP configuré
    const { sendMail } = require('../services/mailer');
    await sendMail({
      to: email,
      subject: '🔐 Code de réinitialisation FacturePilot AI',
      html: `<div style="font-family:sans-serif;max-width:420px">
        <h2 style="color:#1B3A4B">FacturePilot AI</h2>
        <p>Bonjour <strong>${user.prenom}</strong>,</p>
        <p>Votre code de réinitialisation est :</p>
        <div style="font-size:2rem;font-weight:800;letter-spacing:.3em;color:#1B3A4B;background:#F4F7FA;padding:16px 24px;border-radius:10px;display:inline-block;margin:12px 0">${code}</div>
        <p style="color:#6b7a8a;font-size:.85em">Ce code expire dans 15 minutes.<br/>Si vous n'avez pas fait cette demande, ignorez cet email.</p>
      </div>`,
    }).catch(err => console.log(`[Reset code pour ${email}] : ${code}`, err.message));
  } else {
    // Email inexistant — on log le code en console pour le mode démo
    console.log(`[Reset demandé pour email inconnu : ${email}]`);
  }

  res.json({ message: `Si cet email est associé à un compte, un code de vérification a été envoyé. (Mode démo : code = ${user ? code : 'N/A'})` });
});

// POST /api/auth/reset-password
router.post('/reset-password', (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Champs requis manquants' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Mot de passe trop court' });

  const key   = email.toLowerCase().trim();
  const entry = resetTokens.get(key);
  if (!entry) return res.status(400).json({ error: 'Aucun code de réinitialisation pour cet email' });
  if (Date.now() > entry.expires) { resetTokens.delete(key); return res.status(400).json({ error: 'Code expiré, veuillez recommencer' }); }
  if (entry.code !== code.trim()) return res.status(400).json({ error: 'Code incorrect' });

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(key);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  resetTokens.delete(key);
  res.json({ ok: true });
});

// POST /api/auth/password — change password
const auth = require('../middleware/auth');
router.post('/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Champs requis' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Nouveau mot de passe trop court (6 chars min)' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const ok = bcrypt.compareSync(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
