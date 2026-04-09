'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

const daysLate = (dateEcheance) => {
  const diff = Date.now() - new Date(dateEcheance).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

const fmt = (inv) => {
  const relances = db.prepare('SELECT * FROM relances WHERE invoice_id = ? ORDER BY created_at').all(inv.id);
  // Auto-update statut if past due
  let statut = inv.statut;
  if (statut === 'envoyee' && daysLate(inv.date_echeance) > 0) statut = 'retard';
  return {
    id: String(inv.id), userId: inv.user_id,
    clientId: inv.client_id ? String(inv.client_id) : null,
    clientNom: inv.client_nom,
    numero: inv.numero, objet: inv.objet,
    lignes: inv.lignes || '',
    montantHT: inv.montant_ht, tva: inv.tva, montantTTC: inv.montant_ttc,
    dateEmission: inv.date_emission, dateEcheance: inv.date_echeance,
    statut, factureX: !!inv.facture_x, notes: inv.notes || '',
    createdAt: inv.created_at,
    relances: relances.map(r => ({
      id: r.id, type: r.type, ton: r.ton,
      message: r.message, statut: r.statut, date: r.created_at.split('T')[0] || r.created_at,
    })),
  };
};

// GET /api/invoices
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY date_emission DESC').all(req.user.id);
  res.json(rows.map(fmt));
});

// GET /api/invoices/:id
router.get('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Facture introuvable' });
  res.json(fmt(row));
});

// POST /api/invoices
router.post('/', auth, (req, res) => {
  const { clientId, clientNom, numero, objet, lignes, montantHT, tva, montantTTC, dateEmission, dateEcheance, statut, notes } = req.body;
  if (!montantHT || !dateEmission || !dateEcheance)
    return res.status(400).json({ error: 'Champs obligatoires manquants' });

  // Auto-generate numero if missing
  let num = numero;
  if (!num) {
    const year = new Date().getFullYear();
    const last = db.prepare(`SELECT numero FROM invoices WHERE user_id=? AND numero LIKE 'FA-${year}-%' ORDER BY id DESC LIMIT 1`).get(req.user.id);
    const n = last ? parseInt(last.numero.split('-')[2]) + 1 : 1;
    num = `FA-${year}-${String(n).padStart(3,'0')}`;
  }
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO invoices (user_id,client_id,client_nom,numero,objet,lignes,montant_ht,tva,montant_ttc,date_emission,date_echeance,statut,facture_x,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
  `).run(req.user.id, clientId||null, clientNom||'', num, objet||'', lignes||'', montantHT, tva||20, montantTTC, dateEmission, dateEcheance, statut||'brouillon', notes||'');

  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(lastInsertRowid);
  res.status(201).json(fmt(row));
});

// PUT /api/invoices/:id
router.put('/:id', auth, (req, res) => {
  const existing = db.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Facture introuvable' });
  const { clientId, clientNom, numero, objet, lignes, montantHT, tva, montantTTC, dateEmission, dateEcheance, statut, notes } = req.body;
  db.prepare(`
    UPDATE invoices SET client_id=?,client_nom=?,numero=?,objet=?,lignes=?,montant_ht=?,tva=?,montant_ttc=?,
      date_emission=?,date_echeance=?,statut=?,notes=?
    WHERE id=? AND user_id=?
  `).run(clientId||null, clientNom||'', numero, objet||'', lignes||'', montantHT, tva||20, montantTTC, dateEmission, dateEcheance, statut, notes||'', req.params.id, req.user.id);
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  res.json(fmt(row));
});

// PATCH /api/invoices/:id/statut
router.patch('/:id/statut', auth, (req, res) => {
  const { statut } = req.body;
  const valid = ['brouillon','envoyee','retard','payee'];
  if (!valid.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const existing = db.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Facture introuvable' });
  db.prepare('UPDATE invoices SET statut=? WHERE id=? AND user_id=?').run(statut, req.params.id, req.user.id);
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  res.json(fmt(row));
});

// POST /api/invoices/:id/relances
router.post('/:id/relances', auth, async (req, res) => {
  const inv = db.prepare('SELECT invoices.*, clients.email as client_email FROM invoices LEFT JOIN clients ON invoices.client_id = clients.id WHERE invoices.id = ? AND invoices.user_id = ?').get(req.params.id, req.user.id);
  if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
  const { type, ton, message } = req.body;
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO relances (invoice_id,type,ton,message,statut) VALUES (?,?,?,?,?)'
  ).run(req.params.id, type||'email', ton||'cordial', message||'', 'envoyée');
  const r = db.prepare('SELECT * FROM relances WHERE id = ?').get(lastInsertRowid);

  // Envoi email si type=email et adresse disponible
  if ((type||'email') === 'email' && message && inv.client_email) {
    const { sendMail } = require('../services/mailer');
    const user = db.prepare('SELECT prenom, nom, entreprise FROM users WHERE id = ?').get(req.user.id);
    sendMail({
      to: inv.client_email,
      subject: `Relance facture ${inv.numero} — ${user?.entreprise || 'FacturePilot AI'}`,
      html: `<div style="font-family:sans-serif;max-width:520px"><p>${message.replace(/\n/g,'<br/>')}</p><hr style="border:none;border-top:1px solid #eee;margin:16px 0"/><p style="color:#6b7a8a;font-size:.82em">${user?.prenom} ${user?.nom} — ${user?.entreprise}</p></div>`,
      text: message,
    }).catch(err => console.error('[MAIL relance]', err.message));
  }

  res.status(201).json({ id: r.id, type: r.type, ton: r.ton, message: r.message, statut: r.statut, date: r.created_at.split('T')[0] });
});

// POST /api/invoices/:id/send-email — envoie la facture par email au client
router.post('/:id/send-email', auth, async (req, res) => {
  const inv = db.prepare(`
    SELECT invoices.*, clients.email as client_email, clients.nom as client_name
    FROM invoices
    LEFT JOIN clients ON invoices.client_id = clients.id
    WHERE invoices.id = ? AND invoices.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
  if (!inv.client_email) return res.status(400).json({ error: 'Ce client n\'a pas d\'adresse email' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { sendMail } = require('../services/mailer');

  const montantHT  = Number(inv.montant_ht).toLocaleString('fr-FR', { minimumFractionDigits:2 });
  const montantTTC = Number(inv.montant_ttc).toLocaleString('fr-FR', { minimumFractionDigits:2 });
  const dateEch    = new Date(inv.date_echeance).toLocaleDateString('fr-FR');

  try {
    await sendMail({
      to: inv.client_email,
      subject: `Facture ${inv.numero} — ${user.entreprise}`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:580px;margin:0 auto">
          <div style="background:#1B3A4B;padding:24px 28px;border-radius:10px 10px 0 0">
            <h2 style="color:white;margin:0;font-size:1.3rem">Facture ${inv.numero}</h2>
            <div style="color:rgba(255,255,255,.65);font-size:.9rem;margin-top:4px">${user.entreprise}</div>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;padding:28px;border-radius:0 0 10px 10px">
            <p style="color:#374151">Bonjour ${inv.client_name || 'Madame, Monsieur'},</p>
            <p style="color:#374151">Veuillez trouver ci-joint notre facture <strong>${inv.numero}</strong> d'un montant de <strong>${montantTTC} € TTC</strong>, à régler avant le <strong>${dateEch}</strong>.</p>
            <div style="background:#f9fafb;border-radius:8px;padding:16px 20px;margin:20px 0">
              <div style="display:flex;justify-content:space-between;color:#6b7280;font-size:.9rem;margin-bottom:6px">
                <span>Montant HT</span><span>${montantHT} €</span>
              </div>
              <div style="display:flex;justify-content:space-between;color:#6b7280;font-size:.9rem;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #e5e7eb">
                <span>TVA (${inv.tva}%)</span><span>${(Number(inv.montant_ttc)-Number(inv.montant_ht)).toLocaleString('fr-FR',{minimumFractionDigits:2})} €</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-weight:700;font-size:1.05rem;color:#1B3A4B">
                <span>Total TTC</span><span>${montantTTC} €</span>
              </div>
            </div>
            ${user.iban ? `<p style="color:#6b7280;font-size:.88rem">Paiement par virement : IBAN <strong>${user.iban}</strong></p>` : ''}
            <p style="color:#374151;margin-top:20px">Cordialement,<br/><strong>${user.prenom} ${user.nom}</strong><br/><span style="color:#6b7280">${user.entreprise}</span>${user.tel ? `<br/><span style="color:#6b7280">${user.tel}</span>` : ''}</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0"/>
            <p style="font-size:.78rem;color:#9ca3af;text-align:center">✓ Facture au format Factur-X conforme réforme 2026 · Généré par FacturePilot AI</p>
          </div>
        </div>
      `,
      text: `Facture ${inv.numero} — ${user.entreprise}\n\nMontant TTC : ${montantTTC} €\nÀ régler avant le ${dateEch}\n${user.iban ? `Virement IBAN : ${user.iban}` : ''}`,
    });

    // Passer la facture en "envoyée" si c'était un brouillon
    if (inv.statut === 'brouillon') {
      db.prepare("UPDATE invoices SET statut='envoyee' WHERE id=?").run(req.params.id);
    }

    res.json({ ok: true, message: `Facture envoyée à ${inv.client_email}` });
  } catch (err) {
    console.error('[MAIL facture]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/invoices/:id
router.delete('/:id', auth, (req, res) => {
  const existing = db.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Facture introuvable' });
  db.prepare('DELETE FROM relances WHERE invoice_id = ?').run(req.params.id);
  db.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// GET /api/invoices/stats/aging — balance âgée
router.get('/stats/aging', auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM invoices WHERE user_id=? AND statut IN ('envoyee','retard')").all(req.user.id);
  const now = Date.now();
  const age = (d) => Math.floor((now - new Date(d).getTime()) / (1000*60*60*24));
  const buckets = { aVenir:0, j0_30:0, j31_60:0, j60plus:0 };
  const counts  = { aVenir:0, j0_30:0, j31_60:0, j60plus:0 };
  rows.forEach(inv => {
    const late = daysLate(inv.date_echeance);
    if (late < 0)      { buckets.aVenir  += inv.montant_ttc; counts.aVenir++;  }
    else if (late < 31){ buckets.j0_30   += inv.montant_ttc; counts.j0_30++;   }
    else if (late < 61){ buckets.j31_60  += inv.montant_ttc; counts.j31_60++;  }
    else               { buckets.j60plus += inv.montant_ttc; counts.j60plus++; }
  });
  res.json({ amounts: buckets, counts });
});

module.exports = router;
