'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { decrypt } = require('../services/crypto');

const router = express.Router();

const PLAN_LIMITS = { essentiel: 10, pro: 100, business: Infinity };

async function checkPlanLimit(userId) {
  const { rows: [u] } = await db.query('SELECT plan FROM users WHERE id=$1', [userId]);
  const plan  = (u?.plan || 'essentiel').toLowerCase();
  const limit = PLAN_LIMITS[plan] ?? 10;
  if (limit === Infinity) return null; // pas de limite
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const { rows: [{ count }] } = await db.query(
    "SELECT COUNT(*) FROM invoices WHERE user_id=$1 AND created_at >= $2 AND statut != 'brouillon'",
    [userId, monthStart.toISOString()]
  );
  if (parseInt(count) >= limit) {
    return { error: `Limite de ${limit} factures/mois atteinte sur le plan ${plan}. Passez au plan supérieur.`, upgrade: true, limit, current: parseInt(count) };
  }
  return null;
}

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

// GET /api/invoices/export/fec — export FEC DGFiP (partie double conforme)
router.get('/export/fec', auth, async (req, res) => {
  try {
    const { rows: invoices } = await db.query(
      `SELECT i.*, c.siret as client_siret
       FROM invoices i LEFT JOIN clients c ON i.client_id = c.id
       WHERE i.user_id = $1 AND i.statut IN ('envoyee','payee','retard')
       ORDER BY i.date_emission, i.id`,
      [req.user.id]
    );
    const { rows: [user] } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);

    const sep = '\t';
    const COLS = ['JournalCode','JournalLib','EcritureNum','EcritureDate','CompteNum','CompteLib',
      'CompAuxNum','CompAuxLib','PieceRef','PieceDate','EcritureLib','Debit','Credit',
      'EcritureLet','DateLet','ValidDate','Montantdevise','Idevise'];

    const lines = [COLS.join(sep)];
    const fmt   = (n) => Number(n).toFixed(2).replace('.', ',');
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    let vtN = 0, bqN = 0;
    const vtNum = () => `VT${String(++vtN).padStart(6,'0')}`;
    const bqNum = () => `BQ${String(++bqN).padStart(6,'0')}`;
    const row   = (fields) => lines.push(fields.join(sep));

    invoices.forEach((inv) => {
      const dateStr    = String(inv.date_emission).replace(/-/g, '');
      const eNum       = vtNum();
      const montantHT  = fmt(inv.montant_ht);
      const montantTTC = fmt(inv.montant_ttc);
      const tvaAmt     = fmt(Number(inv.montant_ttc) - Number(inv.montant_ht));
      const clientCode = `CLI${String(inv.client_id || 0).padStart(5,'0')}`;
      const clientLib  = (inv.client_nom || 'Client').slice(0,40).replace(/\t/g,' ');
      const pieceLib   = (inv.objet || inv.numero).slice(0,99).replace(/\t/g,' ');

      // ── Écriture ventes ───────────────────────────────────────────────────────
      // Débit 411 Clients (créance = TTC)
      row(['VT','Ventes', eNum, dateStr, '411000','Clients', clientCode, clientLib,
           inv.numero, dateStr, pieceLib, montantTTC, '0,00', '','', today,'','']);
      // Crédit 706 Prestations de services (HT)
      row(['VT','Ventes', eNum, dateStr, '706000','Prestations de services', '','',
           inv.numero, dateStr, pieceLib, '0,00', montantHT, '','', today,'','']);
      // Crédit 445711 TVA collectée
      if (Number(inv.tva) > 0) {
        row(['VT','Ventes', eNum, dateStr, '445711',`TVA collectée ${inv.tva}%`, '','',
             inv.numero, dateStr, `TVA ${inv.tva}%`, '0,00', tvaAmt, '','', today,'','']);
      }

      // ── Écriture règlement (factures payées uniquement) ───────────────────────
      if (inv.statut === 'payee') {
        const bNum    = bqNum();
        const payDate = dateStr;
        const lettre  = inv.numero.replace(/[^A-Z0-9]/gi,'').slice(0,3).toUpperCase();
        // Débit 512 Banque
        row(['BQ','Banque', bNum, payDate, '512000','Banque', '','',
             inv.numero, payDate, `Règlement ${inv.numero}`, montantTTC, '0,00',
             lettre, payDate, today,'','']);
        // Crédit 411 Clients (apurement créance)
        row(['BQ','Banque', bNum, payDate, '411000','Clients', clientCode, clientLib,
             inv.numero, payDate, `Règlement ${inv.numero}`, '0,00', montantTTC,
             lettre, payDate, today,'','']);
      }
    });

    const siren    = (user.siren || 'SIREN').replace(/\s/g,'');
    const year     = new Date().getFullYear();
    const filename = `${siren}FEC${year}1231.txt`;
    const bom      = Buffer.from('\uFEFF','utf8');
    const content  = Buffer.from(lines.join('\r\n'),'utf8');

    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
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
  // Valider que l'id est un entier avant tout accès DB
  const invoiceId = parseInt(req.params.id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) return;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '';
  db.query('INSERT INTO invoice_views (invoice_id, ip) VALUES ($1, $2)', [invoiceId, ip])
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

    // Vérifier limite du plan
    const limitErr = await checkPlanLimit(req.user.id);
    if (limitErr) return res.status(403).json(limitErr);

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
    const existing = (await db.query('SELECT id, statut FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Facture introuvable' });

    if (['envoyee', 'payee', 'retard'].includes(existing.statut)) {
      return res.status(409).json({
        error: 'Une facture émise ou payée ne peut pas être modifiée. Passez-la en brouillon d\'abord ou créez un avoir.',
        statut: existing.statut,
      });
    }

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
    const existing = (await db.query('SELECT id, statut FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Facture introuvable' });

    // ── Règles d'immuabilité comptable ───────────────────────────────────────
    // Une facture payée ne peut jamais être rétrogradée (CGI art. 289)
    if (existing.statut === 'payee') {
      return res.status(409).json({
        error: 'Une facture payée est immuable. Pour la corriger, émettez un avoir.',
        statut: existing.statut,
      });
    }
    // Une facture envoyée ou en retard ne peut repasser en brouillon qu'explicitement
    if (['envoyee','retard'].includes(existing.statut) && statut === 'brouillon') {
      return res.status(409).json({
        error: 'Une facture émise ne peut pas repasser en brouillon. Créez un avoir si une correction est nécessaire.',
        statut: existing.statut,
      });
    }

    await db.query('UPDATE invoices SET statut=$1 WHERE id=$2 AND user_id=$3', [statut, req.params.id, req.user.id]);

    // Log si passage en payée
    if (statut === 'payee') {
      db.query(
        "INSERT INTO audit_log (user_id, action, entity, entity_id, payload, ip) VALUES ($1,'mark_paid','invoice',$2,$3,$4)",
        [req.user.id, parseInt(req.params.id), JSON.stringify({ statut }), req.ip || '']
      ).catch(() => {});
    }

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

    // Générer le PDF et archiver un snapshot des données au moment de l'envoi
    const { generateInvoicePDF } = require('../services/pdf');
    let pdfBuffer = null;
    try {
      pdfBuffer = await generateInvoicePDF(inv, user);
      // Snapshot immuable : on fige les données émetteur+facture pour préserver l'historique
      const snapshot = {
        inv: { numero: inv.numero, objet: inv.objet, montant_ht: inv.montant_ht, tva: inv.tva,
               montant_ttc: inv.montant_ttc, date_emission: inv.date_emission,
               date_echeance: inv.date_echeance, client_nom: inv.client_nom, lignes: inv.lignes },
        user: { prenom: user.prenom, nom: user.nom, entreprise: user.entreprise,
                adresse: user.adresse, siren: user.siren, tva_num: user.tva_num,
                // IBAN déchiffré dans le snapshot — jamais de valeur chiffrée en clair dans le JSON
                iban: user.iban ? decrypt(user.iban) : '',
                bic: user.bic ? decrypt(user.bic) : '',
                tel: user.tel, email: user.email,
                couleur_facture: user.couleur_facture },
        sentAt: new Date().toISOString(),
      };
      db.query('UPDATE invoices SET invoice_snapshot=$1 WHERE id=$2', [JSON.stringify(snapshot), req.params.id])
        .catch(() => {});
    } catch(pdfErr) {
      console.error('[PDF]', pdfErr.message);
    }

    // Déchiffrer IBAN/BIC (stockés AES-256-GCM en DB)
    const ibanClear = user.iban ? decrypt(user.iban) : '';
    const bicClear  = user.bic  ? decrypt(user.bic)  : '';

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
            ${ibanClear ? `<p style="color:#6b7280;font-size:.88rem">Paiement par virement : IBAN <strong>${ibanClear}</strong>${bicClear ? ` — BIC <strong>${bicClear}</strong>` : ''}</p>` : ''}
            <p style="color:#374151;margin-top:20px">Cordialement,<br/><strong>${user.prenom} ${user.nom}</strong><br/><span style="color:#6b7280">${user.entreprise}</span>${user.tel ? `<br/><span style="color:#6b7280">${user.tel}</span>` : ''}</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0"/>
            <p style="font-size:.78rem;color:#9ca3af;text-align:center">✓ Facture au format Factur-X conforme réforme 2026 · Généré par FacturePilot AI</p>
            <img src="https://facturepilot-ai-beta111.vercel.app/api/invoices/${inv.id}/pixel.gif" width="1" height="1" style="display:block" alt=""/>
          </div>
        </div>
      `,
      text: `Facture ${inv.numero} — ${user.entreprise}\n\nMontant TTC : ${montantTTC} €\nÀ régler avant le ${dateEch}\n${ibanClear ? `Virement IBAN : ${ibanClear}${bicClear ? ` — BIC : ${bicClear}` : ''}` : ''}`,
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

    // Log audit
    db.query(
      "INSERT INTO audit_log (user_id, action, entity, entity_id, payload, ip) VALUES ($1,'send_invoice','invoice',$2,$3,$4)",
      [req.user.id, parseInt(req.params.id), JSON.stringify({ to: inv.client_email, numero: inv.numero, montant: inv.montant_ttc }), req.ip || '']
    ).catch(() => {});

    res.json({ ok: true, message: `Facture envoyée à ${inv.client_email}` });
  } catch (err) {
    console.error('[MAIL facture]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/:id/facturx — PDF/A-3b avec XML EN 16931 embarqué (Factur-X officiel)
router.get('/:id/facturx', auth, async (req, res) => {
  try {
    const inv = (await db.query(
      `SELECT i.*, c.siret as client_siret, c.adresse as client_adresse, c.email as client_email,
              c.nom as client_nom_contact
       FROM invoices i LEFT JOIN clients c ON i.client_id = c.id
       WHERE i.id = $1 AND i.user_id = $2`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    if (inv.statut === 'brouillon') return res.status(400).json({ error: 'Impossible de générer un Factur-X pour un brouillon. Finalisez la facture d\'abord.' });

    const user = (await db.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    const client = {
      nom: inv.client_nom_contact || inv.client_nom,
      siret: inv.client_siret || '',
      adresse: inv.client_adresse || '',
    };

    const { buildFacturXML, generateFacturXPDF } = require('../services/facturx');
    const { generateInvoicePDF }                 = require('../services/pdf');

    // 1. Générer le XML EN 16931
    const xmlString = buildFacturXML(inv, user, client);

    // 2. Générer le PDF de base (snapshot figé si dispo, sinon live)
    let invData = inv;
    if (inv.invoice_snapshot) {
      try {
        const snap = typeof inv.invoice_snapshot === 'string'
          ? JSON.parse(inv.invoice_snapshot) : inv.invoice_snapshot;
        invData = { ...inv, ...snap.inv };
      } catch { /* fallback */ }
    }
    const pdfBuffer = await generateInvoicePDF(invData, user);

    // 3. Embedder le XML dans le PDF → PDF/A-3b
    const facturXBuffer = await generateFacturXPDF(pdfBuffer, xmlString, inv.numero);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${inv.numero}-facturx.pdf"`,
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(Buffer.from(facturXBuffer));
  } catch (err) {
    console.error('[FacturX]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/:id/pdf — télécharge le PDF (données figées si facture envoyée)
router.get('/:id/pdf', auth, async (req, res) => {
  try {
    const inv = (await db.query(
      'SELECT * FROM invoices WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )).rows[0];
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });

    const { generateInvoicePDF } = require('../services/pdf');
    let pdfData, snapshotUser;

    // Si un snapshot existe, utiliser les données figées à l'envoi (conformité légale)
    if (inv.invoice_snapshot) {
      try {
        const snap = typeof inv.invoice_snapshot === 'string'
          ? JSON.parse(inv.invoice_snapshot) : inv.invoice_snapshot;
        pdfData     = { ...inv, ...snap.inv };
        snapshotUser = snap.user;
      } catch(e) { /* fallback live */ }
    }

    if (!snapshotUser) {
      snapshotUser = (await db.query('SELECT * FROM users WHERE id=$1', [req.user.id])).rows[0];
    }

    const buf = await generateInvoicePDF(pdfData || inv, snapshotUser);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${inv.numero}.pdf"`,
      'Cache-Control': inv.invoice_snapshot ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(buf);
  } catch(err) {
    console.error('[PDF download]', err.message);
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

// POST /api/invoices/:id/ai-relance — génère un email de relance via LLM
// Plan pro/business uniquement ; retourne { subject, body } sans envoyer l'email
router.post('/:id/ai-relance', auth, async (req, res) => {
  try {
    // Vérif plan (feature pro+)
    const { rows: [u] } = await db.query('SELECT plan FROM users WHERE id=$1', [req.user.id]);
    if (!u || !['pro','business'].includes(u.plan)) {
      return res.status(403).json({ error: 'Fonctionnalité réservée aux plans Pro et Business' });
    }

    const inv = (await db.query(
      `SELECT i.*, c.nom as client_nom_full, c.risque
         FROM invoices i LEFT JOIN clients c ON i.client_id = c.id
        WHERE i.id = $1 AND i.user_id = $2`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });

    // Historique des relances déjà envoyées
    const { rows: hist } = await db.query(
      `SELECT TO_CHAR(created_at,'YYYY-MM-DD') as date, ton FROM relances
        WHERE invoice_id = $1 ORDER BY created_at`,
      [req.params.id]
    );

    const { tone } = req.body; // le front envoie le ton souhaité
    const daysLateVal = Math.max(0,
      Math.floor((Date.now() - new Date(inv.date_echeance)) / 86400000)
    );

    const { generateDunningEmail } = require('../services/ai.service');
    const result = await generateDunningEmail(
      inv.client_nom_full || inv.client_nom,
      Number(inv.montant_ttc),
      daysLateVal,
      tone || 'courtois',
      hist,
      { invoiceNumber: inv.numero }
    );

    res.json(result); // { subject, body }
  } catch (err) {
    console.error('[AI relance]', err.message);
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

// POST /api/invoices/:id/send-pdp — dépôt sur Plateforme de Dématérialisation Partenaire (réforme 2026)
// Conformément à l'ordonnance 2021-1190, obligation à compter du 1er sept. 2026 (grandes entreprises)
// Note : l'intégration avec le PDP réel (ex. Chorus Pro, Docaposte…) nécessite une connexion API externe.
//        Cet endpoint simule le dépôt, met à jour le statut PDP et renvoie la référence.
router.post('/:id/send-pdp', auth, async (req, res) => {
  try {
    const inv = (await db.query(
      'SELECT * FROM invoices WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )).rows[0];
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });

    // Seules les factures émises ou en retard sont éligibles
    if (!['envoyee', 'retard'].includes(inv.statut)) {
      return res.status(400).json({
        error: `La facture doit être émise ou en retard pour être déposée sur la PDP (statut actuel : ${inv.statut})`,
      });
    }

    // Vérifier que le dépôt n'a pas déjà été effectué
    if (inv.pdp_status) {
      return res.status(409).json({
        error: `Cette facture a déjà été déposée sur la PDP (statut : ${inv.pdp_status})`,
        pdp_status: inv.pdp_status,
        pdp_ref: inv.pdp_ref,
      });
    }

    // Générer une référence PDP unique (format simulé — remplacer par l'ID retourné par le PDP réel)
    const pdpRef = `PDP-${inv.numero}-${Date.now().toString(36).toUpperCase()}`;

    // Mettre à jour le statut PDP en base
    const { rows: [updated] } = await db.query(`
      UPDATE invoices
         SET pdp_status  = 'deposee',
             pdp_sent_at = NOW(),
             pdp_ref     = $1
       WHERE id = $2 AND user_id = $3
      RETURNING *
    `, [pdpRef, req.params.id, req.user.id]);

    // Log audit
    db.query(
      "INSERT INTO audit_log (user_id, action, entity, entity_id, payload, ip) VALUES ($1,'send_pdp','invoice',$2,$3,$4)",
      [req.user.id, parseInt(req.params.id), JSON.stringify({ pdp_ref: pdpRef, numero: inv.numero }), req.ip || '']
    ).catch(() => {});

    const { rows: relances } = await db.query(
      'SELECT * FROM relances WHERE invoice_id=$1 ORDER BY created_at',
      [updated.id]
    );

    console.log(`[PDP] ✅ Facture ${inv.numero} déposée — réf. ${pdpRef}`);
    res.json({
      ok: true,
      message: `Facture ${inv.numero} déposée sur la PDP`,
      pdp_ref: pdpRef,
      pdp_status: 'deposee',
      invoice: fmtInv(updated, relances),
    });
  } catch (err) {
    console.error('[PDP]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
