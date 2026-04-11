'use strict';
const PDFDocument = require('pdfkit');
const { decrypt }  = require('./crypto');

function generateInvoicePDF(inv, user) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const couleur = user.couleur_facture || '#1B3A4B';
    const fmt = (n) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2 }) + ' €';

    // ── En-tête coloré ──────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 100).fill(couleur);
    doc.fillColor('white').fontSize(22).font('Helvetica-Bold')
       .text('FACTURE', 50, 30);
    doc.fontSize(11).font('Helvetica')
       .text(inv.numero, 50, 58)
       .text(`Émise le ${new Date(inv.date_emission).toLocaleDateString('fr-FR')}`, 50, 74);

    // logo texte à droite si pas d'image
    doc.fontSize(14).font('Helvetica-Bold')
       .text(user.entreprise || 'Mon Entreprise', 300, 38, { width: 245, align: 'right' });
    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.8)')
       .text(user.adresse || '', 300, 60, { width: 245, align: 'right' })
       .text(user.email || '', 300, 72, { width: 245, align: 'right' });

    // ── Infos émetteur / destinataire ───────────────────────────────────────
    doc.fillColor('#1a1a2e').fontSize(10).font('Helvetica-Bold')
       .text('ÉMETTEUR', 50, 120);
    doc.font('Helvetica').fontSize(9).fillColor('#333')
       .text(user.entreprise || '', 50, 135)
       .text(`SIREN : ${user.siren || 'N/A'}`, 50, 148)
       .text(`TVA : ${user.tva_num || 'N/A'}`, 50, 161)
       .text(user.adresse || '', 50, 174);

    doc.fillColor('#1a1a2e').fontSize(10).font('Helvetica-Bold')
       .text('CLIENT', 300, 120);
    doc.font('Helvetica').fontSize(9).fillColor('#333')
       .text(inv.client_nom || 'Client', 300, 135);

    // ── Dates ───────────────────────────────────────────────────────────────
    doc.roundedRect(50, 210, 495, 36, 6).fill('#f4f7fa');
    doc.fillColor('#333').fontSize(9)
       .text(`Date d'émission : ${new Date(inv.date_emission).toLocaleDateString('fr-FR')}`, 62, 222)
       .text(`Date d'échéance : ${new Date(inv.date_echeance).toLocaleDateString('fr-FR')}`, 270, 222)
       .text(`Référence : ${inv.numero}`, 420, 222);

    // ── Objet ───────────────────────────────────────────────────────────────
    if (inv.objet) {
      doc.fillColor('#555').fontSize(10).font('Helvetica-Oblique')
         .text(`Objet : ${inv.objet}`, 50, 262);
    }

    // ── Tableau des lignes ──────────────────────────────────────────────────
    const tableY = 285;
    doc.rect(50, tableY, 495, 24).fill(couleur);
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
       .text('Description', 60, tableY + 8)
       .text('Qté', 340, tableY + 8, { width: 50, align: 'right' })
       .text('PU HT', 395, tableY + 8, { width: 60, align: 'right' })
       .text('Total HT', 460, tableY + 8, { width: 80, align: 'right' });

    let lignes = [];
    try { lignes = JSON.parse(inv.lignes || '[]'); } catch(_) {}
    if (!lignes.length) {
      lignes = [{ description: inv.objet || 'Prestation', quantite: 1, prix_unitaire: inv.montant_ht, total: inv.montant_ht }];
    }

    let rowY = tableY + 28;
    doc.font('Helvetica').fillColor('#333');
    lignes.forEach((l, idx) => {
      if (idx % 2 === 0) doc.rect(50, rowY - 4, 495, 20).fill('#f9fafb');
      doc.fillColor('#333').fontSize(9)
         .text(l.description || '', 60, rowY, { width: 270 })
         .text(String(l.quantite || 1), 340, rowY, { width: 50, align: 'right' })
         .text(fmt(l.prix_unitaire || 0), 395, rowY, { width: 60, align: 'right' })
         .text(fmt(l.total || 0), 460, rowY, { width: 80, align: 'right' });
      rowY += 22;
    });

    // ── Totaux ──────────────────────────────────────────────────────────────
    const totY = rowY + 16;
    doc.rect(350, totY, 195, 1).fill('#e5e7eb');

    const tvaAmt = Number(inv.montant_ttc) - Number(inv.montant_ht);
    doc.fillColor('#555').fontSize(9)
       .text('Montant HT', 350, totY + 8).text(fmt(inv.montant_ht), 460, totY + 8, { width: 80, align: 'right' })
       .text(`TVA (${inv.tva}%)`, 350, totY + 24).text(fmt(tvaAmt), 460, totY + 24, { width: 80, align: 'right' });

    doc.rect(350, totY + 40, 195, 30).fill(couleur);
    doc.fillColor('white').fontSize(12).font('Helvetica-Bold')
       .text('TOTAL TTC', 360, totY + 50).text(fmt(inv.montant_ttc), 400, totY + 50, { width: 140, align: 'right' });

    // ── IBAN ────────────────────────────────────────────────────────────────
    // user.iban/bic sont chiffrés en DB (AES-256-GCM) — déchiffrement avant affichage
    const ibanClear = user.iban ? decrypt(user.iban) : '';
    const bicClear  = user.bic  ? decrypt(user.bic)  : '';
    if (ibanClear) {
      const ibanY = totY + 90;
      doc.rect(50, ibanY, 495, 40).fill('#f4f7fa');
      doc.fillColor('#333').fontSize(9).font('Helvetica-Bold')
         .text('Règlement par virement bancaire :', 60, ibanY + 8);
      doc.font('Helvetica').text(`IBAN : ${ibanClear}`, 60, ibanY + 22);
      if (bicClear) doc.text(`BIC : ${bicClear}`, 300, ibanY + 22);
    }

    // ── Pied de page ────────────────────────────────────────────────────────
    doc.fontSize(7).fillColor('#999').font('Helvetica')
       .text('Document généré par FacturePilot AI — Conforme Factur-X réforme 2026', 50, 780, { align: 'center', width: 495 });

    doc.end();
  });
}

module.exports = { generateInvoicePDF };
