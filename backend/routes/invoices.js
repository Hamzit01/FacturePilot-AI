'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

const daysLate = (dateEcheance) => {
  const diff = Date.now() - new Date(dateEcheance).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

const toDate = (v) => {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v).split('T')[0];
};

const fmtInv = (inv, relances = [], views = 0) => {
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
    views,
    createdAt: inv.created_at instanceof Date ? inv.created_at.toISOString() : inv.created_at,
    relances: relances.map(r => ({
      id: r.id, type: r.type, ton: r.ton,
      message: r.message, statut: r.statut, date: toDate(r.created_at),
    })),
  };
};

// GET /api/invoices/export/fec — export FEC pour expert-comptable
router.get('/export/fec', auth, async (req, res) => {
  try {
    const { rows: invoices } = await db.query(
      "SELECT * FROM invoices WHERE user_id = $1 AND statut IN ('envoyee','payee','retard') ORDER BY date_emission",
      [req.user.id]
    );
    const { rows: [user] } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);

    // Format FEC : fichier texte tabulé, encodage UTF-8 avec BOM
    const sep = '\t';
    const headers = ['JournalCode','JournalLib','EcritureNum','EcritureDate','CompteNum','CompteLib','CompAuxNum','CompAuxLib','PieceRef','PieceDate','EcritureLib','Debit','Credit','EcritureLet','DateLet','ValidDate','Montantdevise','Idevise'].join(sep);

    const lines = [headers];
    invoices.forEach((inv, idx) => {
      const dateStr = inv.date_emission.replace(/-/g, '');
      const num = String(idx + 1).padStart(6, '0');
      const montantHT = Number(inv.montant_ht).toFixed(2).replace('.', ',');
      const tvaAmt = (Number(inv.montant_ttc) - Number(inv.montant_ht)).toFixed(2).replace('.', ',');

      // Ligne client (débit)
      lines.push([
        'VT', 'Ventes', `VT${num}`, dateStr,
        '411000', 'Clients', inv.client_nom.slice(0,17).replace(/\t/g,' '), inv.client_nom.replace(/\t/g,' '),
        inv.numero, dateStr, (inv.objet || inv.numero).slice(0,99).replace(/\t/g,' '),
        Number(inv.montant_ttc).toFixed(2).replace('.', ','), '0,00',
        '', '', dateStr, '', ''
      ].join(sep));

      // Ligne produit (crédit HT)
      lines.push([
        'VT', 'Ventes', `VT${num}`, dateStr,
        '706000', 'Prestations de services', '', '',
        inv.numero, dateStr, (inv.objet || inv.numero).slice(0,99).replace(/\t/g,' '),
        '0,00', montantHT,
        '', '', dateStr, '', ''
      ].join(sep));

      // Ligne TVA (crédit TVA)
      if (inv.tva > 0) {
        lines.push([
          'VT', 'Ventes', `VT${num}`, dateStr,
          '445710', 'TVA collectée', '', '',
          inv.numero, dateStr, `TVA ${inv.tva}%`,
          '0,00', tvaAmt,
          '', '', dateStr, '', ''
        ].join(sep));
      }
    });

    const siren = (user.siren || 'SIREN').replace(/\s/g,'');
    const year = new Date().getFullYear();
    const filename = `${siren}FEC${year}1231.txt`;
    const bom = Buffer.from('\uFEFF', 'utf8');
    const content = Buffer.from(lines.join('\r\n'), 'utf8');

    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': bom.length + content.length,
    });
    res.end(Buffer.concat([bom, content]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices
router.get('/', auth, async (req, res) => {
  try {
    const { rows: invRows } = await db.query(
      'SELECT * FROM invoices WHERE user_id = $1 ORDER BY date_emission DESC',
      [req.user.id]
    );

    let relancesMap = {};
    let viewsMap = {};
    if (invRows.length > 0) {
      const { rows: relRows } = await db.query(
        'SELECT * FROM relances WHERE invoice_id = ANY($1::int[]) ORDER BY created_at',
        [invRows.map(i => i.id)]
      );
      relancesMap = relRows.reduce((acc, r) => {
        if (!acc[r.invoice_id]) acc[r.invoice_id] = [];
        acc[r.invoice_id].push(r);
        return acc;
      }, {});

      const { rows: viewRows } = await db.query(
        'SELECT invoice_id, COUNT(*) as count FROM invoice_views WHERE invoice_id = ANY($1::int[]) GROUP BY invoice_id',
        [invRows.map(i => i.id)]
      );
      viewsMap = viewRows.reduce((acc, r) => { acc[r.invoice_id] = parseInt(r.count); return acc; }, {});
    }

    res.json(invRows.map(inv => fmtInv(inv, relancesMap[inv.id] || [], viewsMap[inv.id] || 0)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/:id/pixel.gif — pixel de tracking (1x1 GIF transparent)
router.get('/:id/pixel.gif', async (req, res) => {
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'Content-Length': GIF.length });
  res.end(GIF);
  // Log en arrière-plan (non bloquant)
  const ip = req.headers['x-forwarded-for'] || req.ip || '';
  db.query('INSERT INTO invoice_views (invoice_id, ip) VALUES ($1, $2)', [req.params.id, ip])
    .catch(() => {});
});

// GET /api/invoices/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const row = (await db.query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Facture introuvable' });
    const { rows: relances } = await db.query('SELECT * FROM relances WHERE invoice_id = $1 ORDER BY created_at', [row.id]);
    const { rows: viewRows } = await db.query('SELECT COUNT(*) as count FROM invoice_views WHERE invoice_id = $1', [row.id]);
    const views = parseInt(viewRows[0]?.count || 0);
    res.json(fmtInv(row, relances, views));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices
router.post('/', auth, async (req, res) => {
  try {
    const { clientId, clientNom, numero, objet, lignes, montantHT, tva, montantTTC, dateEmission, dateEcheance, statut, notes } = req.body;
    if (!montantHT || !dateEmission || !dateEcheance)
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    // Validation : montantHT doit être > 0
    if (Number(montantHT) <= 0)
      return res.status(400).json({ error: 'Le montant HT doit être supérieur à 0' });
    // Validation : dateEcheance doit être >= dateEmission
    if (new Date(dateEcheance) < new Date(dateEmission))
      return res.status(400).json({ error: 'La date d\'échéance doit être postérieure ou égale à la date d\'émission' });

    // Auto-generate numero if missing
    let num = numero;
    if (!num) {
      const year = new Date().getFullYear();
      const { rows: [last] } = await db.query(
        `SELECT numero FROM invoices WHERE user_id=$1 AND numero LIKE $2 ORDER BY id DESC LIMIT 1`,
        [req.user.id, `FA-${year}-%`]
      );
      const n = last ? parseInt(last.numero.split('-')[2]) + 1 : 1;
      num = `FA-${year}-${String(n).padStart(3,'0')}`;
    }

    const { rows: [inserted] } = await db.query(`
      INSERT INTO invoices (user_id,client_id,client_nom,numero,objet,lignes,montant_ht,tva,montant_ttc,date_emission,date_echeance,statut,facture_x,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13) RETURNING id
    `, [req.user.id, clientId||null, clientNom||'', num, objet||'', lignes||'', montantHT, tva||20, montantTTC, dateEmission, dateEcheance, statut||'brouillon', notes||'']);

    const row = (await db.query('SELECT * FROM invoices WHERE id = $1', [inserted.id])).rows[0];
    res.status(201).json(fmtInv(row, []));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/invoices/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const existing = (await db.query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Facture introuvable' });
    const { clientId, clientNom, numero, objet, lignes, montantHT, tva, montantTTC, dateEmission, dateEcheance, statut, notes } = req.body;
    await db.query(`
      UPDATE invoices SET client_id=$1,client_nom=$2,numero=$3,objet=$4,lignes=$5,montant_ht=$6,tva=$7,montant_ttc=$8,
        date_emission=$9,date_echeance=$10,statut=$11,notes=$12
      WHERE id=$13 AND user_id=$14
    `, [clientId||null, clientNom||'', numero, objet||'', lignes||'', montantHT, tva||20, montantTTC, dateEmission, dateEcheance, statut, notes||'', req.params.id, req.user.id]);
    const row = (await db.query('SELECT * FROM invoices WHERE id = $1', [req.params.id])).rows[0];
    const { rows: relances } = await db.query('SELECT * FROM relances WHERE invoice_id = $1 ORDER BY created_at', [row.id]);
    res.json(fmtInv(row, relances));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/invoices/:id/statut
router.patch('/:id/statut', auth, async (req, res) => {
  try {
    const { statut } = req.body;
    const valid = ['brouillon','envoyee','retard','payee'];
    if (!valid.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
    const existing = (await db.query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Facture introuvable' });
    await db.query('UPDATE invoices SET statut=$1 WHERE id=$2 AND user_id=$3', [statut, req.params.id, req.user.id]);
    const row = (await db.query('SELECT * FROM invoices WHERE id = $1', [req.params.id])).rows[0];
    const { rows: relances } = await db.query('SELECT * FROM relances WHERE invoice_id = $1 ORDER BY created_at', [row.id]);
    res.json(fmtInv(row, relances));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices/:id/relances
router.post('/:id/relances', auth, async (req, res) => {
  try {
    const inv = (await db.query(
      'SELECT invoices.*, clients.email as client_email FROM invoices LEFT JOIN clients ON invoices.client_id = clients.id WHERE invoices.id = $1 AND invoices.user_id = $2',
      [req.params.id, req.user.id]
    )).rows[0];
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    const { type, ton, message } = req.body;
    const { rows: [r] } = await db.query(
      'INSERT INTO relances (invoice_id,type,ton,message,statut) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, type||'email', ton||'cordial', message||'', 'envoyée']
    );

    // Envoi email si type=email et adresse disponible
    if ((type||'email') === 'email' && message && inv.client_email) {
      const { sendMail } = require('../services/mailer');
      const user = (await db.query('SELECT prenom, nom, entreprise FROM users WHERE id = $1', [req.user.id])).rows[0];
      sendMail({
        to: inv.client_email,
        subject: `Relance facture ${inv.numero} — ${user?.entreprise || 'FacturePilot AI'}`,
        html: `<div style="font-family:sans-serif;max-width:520px"><p>${message.replace(/\n/g,'<br/>')}</p><hr style="border:none;border-top:1px solid #eee;margin:16px 0"/><p style="color:#6b7a8a;font-size:.82em">${user?.prenom} ${user?.nom} — ${user?.entreprise}</p></div>`,
        text: message,
      }).catch(err => console.error('[MAIL relance]', err.message));
    }

    res.status(201).json({ id: r.id, type: r.type, ton: r.ton, message: r.message, statut: r.statut, date: toDate(r.created_at) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices/:id/send-email — envoie la facture par email au client
router.post('/:id/send-email', auth, async (req, res) => {
  try {
    const inv = (await db.query(`
      SELECT invoices.*, clients.email as client_email, clients.nom as client_name
      FROM invoices
      LEFT JOIN clients ON invoices.client_id = clients.id
      WHERE invoices.id = $1 AND invoices.user_id = $2
    `, [req.params.id, req.user.id])).rows[0];
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    if (!inv.client_email) return res.status(400).json({ error: 'Ce client n\'a pas d\'adresse email' });

    const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    const { sendMail } = require('../services/mailer');

    // Générer le PDF
    const { generateInvoicePDF } = require('../services/pdf');
    let pdfBuffer = null;
    try {
      pdfBuffer = await generateInvoicePDF(inv, user);
    } catch(pdfErr) {
      console.error('[PDF]', pdfErr.message);
    }

    const montantHT  = Number(inv.montant_ht).toLocaleString('fr-FR', { minimumFractionDigits:2 });
    const montantTTC = Number(inv.montant_ttc).toLocaleString('fr-FR', { minimumFractionDigits:2 });
    const dateEch    = new Date(inv.date_echeance).toLocaleDateString('fr-FR');

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
            <img src="https://facturepilot-ai-beta111.vercel.app/api/invoices/${inv.id}/pixel.gif" width="1" height="1" style="display:block" alt=""/>
          </div>
        </div>
      `,
      text: `Facture ${inv.numero} — ${user.entreprise}\n\nMontant TTC : ${montantTTC} €\nÀ régler avant le ${dateEch}\n${user.iban ? `Virement IBAN : ${user.iban}` : ''}`,
      attachments: pdfBuffer ? [{
        filename: `${inv.numero}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }] : [],
    });

    // Passer la facture en "envoyée" si c'était un brouillon
    if (inv.statut === 'brouillon') {
      await db.query("UPDATE invoices SET statut='envoyee' WHERE id=$1", [req.params.id]);
    }

    res.json({ ok: true, message: `Facture envoyée à ${inv.client_email}` });
  } catch (err) {
    console.error('[MAIL facture]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/invoices/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const existing = (await db.query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Facture introuvable' });
    await db.query('DELETE FROM relances WHERE invoice_id = $1', [req.params.id]);
    await db.query('DELETE FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/stats/aging — balance âgée
router.get('/stats/aging', auth, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM invoices WHERE user_id=$1 AND statut IN ('envoyee','retard')", [req.user.id]);
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
