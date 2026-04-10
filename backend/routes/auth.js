'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sign } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const user = (await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()])).rows[0];
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const token = sign({ id: user.id, email: user.email });
    res.json({ token, user: sanitize(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, prenom, nom, entreprise, siren } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
    // Validation email : doit contenir @ et avoir au moins 6 caractères
    if (email.length < 6 || !email.includes('@') || !email.includes('.'))
      return res.status(400).json({ error: 'Format email invalide' });
    // Validation mot de passe : minimum 8 caractères
    if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum)' });
    // Validation SIREN si fourni : exactement 9 chiffres
    if (siren && !/^\d{9}$/.test(siren.trim()))
      return res.status(400).json({ error: 'SIREN invalide (9 chiffres requis)' });

    const existing = (await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()])).rows[0];
    if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    const hash = bcrypt.hashSync(password, 10);
    const { rows: [inserted] } = await db.query(`
      INSERT INTO users (email, password_hash, prenom, nom, entreprise, siren)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [email.toLowerCase().trim(), hash, prenom || '', nom || '', entreprise || '', siren || '']);

    const user = (await db.query('SELECT * FROM users WHERE id = $1', [inserted.id])).rows[0];
    const token = sign({ id: user.id, email: user.email });

    // Envoyer email de bienvenue (ne pas bloquer la réponse)
    const { sendMail } = require('../services/mailer');
    sendMail({
      to: email,
      subject: '🎉 Bienvenue sur FacturePilot AI !',
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
    <div style="background:#1B3A4B;padding:24px 28px;border-radius:10px 10px 0 0">
      <h2 style="color:white;margin:0;font-size:1.4rem">FacturePilot AI</h2>
      <div style="color:rgba(255,255,255,.65);font-size:.9rem;margin-top:4px">Facturation électronique conforme 2026</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;padding:28px;border-radius:0 0 10px 10px">
      <p style="color:#374151;font-size:1.05rem">Bonjour <strong>${prenom || ''} ${nom || ''}</strong>,</p>
      <p style="color:#374151">Votre compte FacturePilot AI est prêt ! Vous pouvez dès maintenant :</p>
      <ul style="color:#374151;line-height:1.8">
        <li>✅ Créer et envoyer vos factures</li>
        <li>✅ Gérer vos clients</li>
        <li>✅ Générer des factures conformes Factur-X (réforme 2026)</li>
        <li>✅ Suivre vos encours et relances</li>
      </ul>
      <div style="text-align:center;margin:24px 0">
        <a href="https://facturepilot.vercel.app/login.html" style="background:#1B3A4B;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Accéder à mon espace →</a>
      </div>
      <p style="color:#6b7280;font-size:.85rem">Une question ? Répondez à cet email ou écrivez à <a href="mailto:contact@facturepilot.ai" style="color:#1B3A4B">contact@facturepilot.ai</a></p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0"/>
      <p style="font-size:.78rem;color:#9ca3af;text-align:center">FacturePilot AI — Solution de facturation pour indépendants et TPE françaises</p>
    </div>
  </div>`,
    }).catch(err => console.log('[Welcome email]', err.message));

    res.status(201).json({ token, user: sanitize(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const sanitize = (u) => ({
  id: u.id, prenom: u.prenom, nom: u.nom, email: u.email,
  entreprise: u.entreprise, siren: u.siren, tva: u.tva_num,
  adresse: u.adresse, tel: u.tel, iban: u.iban, bic: u.bic,
  plan: u.plan, couleurFacture: u.couleur_facture, logo: u.logo,
  createdAt: u.created_at instanceof Date ? u.created_at.toISOString() : u.created_at,
});

// ─── Mot de passe oublié ────────────────────────────────────────────────────
// Stockage en mémoire : { email → { code, expires } }
const resetTokens = new Map();

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  // On répond toujours avec succès pour ne pas divulguer les emails existants
  const user = (await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()])).rows[0];
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
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Champs requis manquants' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum)' });

    const key   = email.toLowerCase().trim();
    const entry = resetTokens.get(key);
    if (!entry) return res.status(400).json({ error: 'Aucun code de réinitialisation pour cet email' });
    if (Date.now() > entry.expires) { resetTokens.delete(key); return res.status(400).json({ error: 'Code expiré, veuillez recommencer' }); }
    if (entry.code !== code.trim()) return res.status(400).json({ error: 'Code incorrect' });

    const user = (await db.query('SELECT id FROM users WHERE email = $1', [key])).rows[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const hash = bcrypt.hashSync(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    resetTokens.delete(key);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/password — change password
const auth = require('../middleware/auth');
router.post('/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Champs requis' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Nouveau mot de passe trop court (8 caractères minimum)' });
    const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const ok = bcrypt.compareSync(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const hash = bcrypt.hashSync(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
