'use strict';
/**
 * Génère un PDF/A-3b avec XML Factur-X EN 16931 (profil Basic) embarqué
 * conforme à la norme NF Z44-060 et à la réforme facturation 2026
 */
const { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const { create } = require('xmlbuilder2');
const { decrypt } = require('./crypto');

// ── XML Factur-X EN 16931 (Basic) ────────────────────────────────────────────
function buildFacturXML(inv, user, client) {
  // Déchiffrer IBAN/BIC stockés AES-256-GCM en DB
  const ibanClear = user.iban ? decrypt(user.iban) : '';
  const bicClear  = user.bic  ? decrypt(user.bic)  : '';
  // Proxy pour que le reste de la fonction utilise les valeurs en clair
  user = { ...user, iban: ibanClear, bic: bicClear };
  const ht      = Number(inv.montant_ht  || 0);
  const ttc     = Number(inv.montant_ttc || 0);
  const tvaRate = Number(inv.tva || 20);
  const tvaAmt  = parseFloat((ttc - ht).toFixed(2));
  const dateIss = String(inv.date_emission || '').replace(/-/g, '');
  const dateEch = String(inv.date_echeance || '').replace(/-/g, '');

  let lignes;
  try { lignes = inv.lignes ? JSON.parse(inv.lignes) : null; } catch { lignes = null; }
  if (!lignes?.length) lignes = [{ description: inv.objet || 'Prestation', qte: 1, prixHT: ht }];

  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('rsm:CrossIndustryInvoice', {
      'xmlns:rsm': 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
      'xmlns:ram': 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
      'xmlns:udt': 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
    });

  // ── En-tête ────────────────────────────────────────────────────────────────
  root.ele('rsm:ExchangedDocumentContext')
        .ele('ram:GuidelineSpecifiedDocumentContextParameter')
          .ele('ram:ID').txt('urn:factur-x.eu:1p0:en16931').up()
        .up()
      .up();

  root.ele('rsm:ExchangedDocument')
        .ele('ram:ID').txt(inv.numero).up()
        .ele('ram:TypeCode').txt('380').up()
        .ele('ram:IssueDateTime')
          .ele('udt:DateTimeString', { format: '102' }).txt(dateIss).up()
        .up()
      .up();

  // ── Transaction ────────────────────────────────────────────────────────────
  const txnNode = root.ele('rsm:SupplyChainTradeTransaction');

  // Agreement — Vendeur
  const seller = txnNode
    .ele('ram:ApplicableHeaderTradeAgreement')
      .ele('ram:SellerTradeParty');

  seller.ele('ram:Name').txt(user.entreprise || '').up();
  seller.ele('ram:SpecifiedLegalOrganization')
          .ele('ram:ID', { schemeID: '0002' }).txt(user.siren || '').up()
        .up();
  // Contact vendeur (EN 16931 recommandé)
  seller.ele('ram:DefinedTradeContact')
          .ele('ram:PersonName').txt(`${user.prenom || ''} ${user.nom || ''}`.trim()).up()
          .ele('ram:TelephoneUniversalCommunication')
            .ele('ram:CompleteNumber').txt(user.tel || '').up()
          .up()
          .ele('ram:EmailURIUniversalCommunication')
            .ele('ram:URIID').txt(user.email || '').up()
          .up()
        .up();
  seller.ele('ram:SpecifiedTaxRegistration')
          .ele('ram:ID', { schemeID: 'VA' }).txt(user.tva_num || '').up()
        .up();
  seller.ele('ram:PostalTradeAddress')
          .ele('ram:LineOne').txt(user.adresse || '').up()
          .ele('ram:CountryID').txt('FR').up()
        .up();

  // Acheteur
  const agreement = seller.up(); // remonte à ApplicableHeaderTradeAgreement
  agreement.ele('ram:BuyerTradeParty')
      .ele('ram:Name').txt(client?.nom || inv.client_nom || '').up()
      .ele('ram:SpecifiedLegalOrganization')
        .ele('ram:ID', { schemeID: '0009' }).txt(client?.siret || '').up()
      .up()
      .ele('ram:PostalTradeAddress')
        .ele('ram:LineOne').txt(client?.adresse || '').up()
        .ele('ram:CountryID').txt('FR').up()
      .up()
    .up(); // fin BuyerTradeParty → remonte à agreement

  // Livraison
  txnNode.ele('ram:ApplicableHeaderTradeDelivery')
      .ele('ram:ActualDeliverySupplyChainEvent')
        .ele('ram:OccurrenceDateTime')
          .ele('udt:DateTimeString', { format: '102' }).txt(dateIss).up()
        .up()
      .up()
    .up();

  // Règlement
  const settlement = txnNode.ele('ram:ApplicableHeaderTradeSettlement');
  settlement.ele('ram:InvoiceCurrencyCode').txt('EUR').up();

  // PaymentMeans : IBAN inclus seulement si INCLUDE_IBAN_IN_XML=true (opt-in explicite)
  // Par défaut : BIC seul — identifie la banque sans exposer l'IBAN en clair dans le PDF
  if (user.iban && process.env.INCLUDE_IBAN_IN_XML === 'true') {
    const pm = settlement.ele('ram:SpecifiedTradeSettlementPaymentMeans');
    pm.ele('ram:TypeCode').txt('30').up();
    pm.ele('ram:PayeePartyCreditorFinancialAccount')
        .ele('ram:IBANID').txt(user.iban.replace(/\s/g, '')).up()
      .up();
    if (user.bic) {
      pm.ele('ram:PayeePartyCreditorFinancialInstitution')
          .ele('ram:BICID').txt(user.bic.replace(/\s/g, '')).up()
        .up();
    }
    pm.up();
  } else if (user.bic) {
    settlement.ele('ram:SpecifiedTradeSettlementPaymentMeans')
        .ele('ram:TypeCode').txt('30').up()
        .ele('ram:PayeePartyCreditorFinancialInstitution')
          .ele('ram:BICID').txt(user.bic.replace(/\s/g, '')).up()
        .up()
      .up();
  }

  // TVA
  settlement.ele('ram:ApplicableTradeTax')
      .ele('ram:CalculatedAmount').txt(tvaAmt.toFixed(2)).up()
      .ele('ram:TypeCode').txt('VAT').up()
      .ele('ram:BasisAmount').txt(ht.toFixed(2)).up()
      .ele('ram:CategoryCode').txt('S').up()
      .ele('ram:RateApplicablePercent').txt(tvaRate.toFixed(2)).up()
    .up();

  // Termes de paiement
  settlement.ele('ram:SpecifiedTradePaymentTerms')
      .ele('ram:DueDateDateTime')
        .ele('udt:DateTimeString', { format: '102' }).txt(dateEch).up()
      .up()
    .up();

  // Totaux
  settlement.ele('ram:SpecifiedTradeSettlementHeaderMonetarySummation')
      .ele('ram:LineTotalAmount').txt(ht.toFixed(2)).up()
      .ele('ram:TaxBasisTotalAmount').txt(ht.toFixed(2)).up()
      .ele('ram:TaxTotalAmount', { currencyID: 'EUR' }).txt(tvaAmt.toFixed(2)).up()
      .ele('ram:GrandTotalAmount').txt(ttc.toFixed(2)).up()
      .ele('ram:TotalPrepaidAmount').txt('0.00').up()
      .ele('ram:DuePayableAmount').txt(ttc.toFixed(2)).up()
    .up();

  const doc = root; // alias pour le reste du code existant

  // Lignes de détail
  const txn = doc.root().last(); // SupplyChainTradeTransaction
  lignes.forEach((l, i) => {
    const lineTotal = (Number(l.prixHT) * Number(l.qte)).toFixed(2);
    txn.ele('ram:IncludedSupplyChainTradeLineItem')
      .ele('ram:AssociatedDocumentLineDocument')
        .ele('ram:LineID').txt(String(i + 1)).up()
      .up()
      .ele('ram:SpecifiedTradeProduct')
        .ele('ram:Name').txt(l.description || inv.objet || '').up()
      .up()
      .ele('ram:SpecifiedLineTradeAgreement')
        .ele('ram:NetPriceProductTradePrice')
          .ele('ram:ChargeAmount').txt(Number(l.prixHT).toFixed(2)).up()
        .up()
      .up()
      .ele('ram:SpecifiedLineTradeDelivery')
        .ele('ram:BilledQuantity', { unitCode: 'C62' }).txt(Number(l.qte).toFixed(2)).up()
      .up()
      .ele('ram:SpecifiedLineTradeSettlement')
        .ele('ram:ApplicableTradeTax')
          .ele('ram:TypeCode').txt('VAT').up()
          .ele('ram:CategoryCode').txt('S').up()
          .ele('ram:RateApplicablePercent').txt(tvaRate.toFixed(2)).up()
        .up()
        .ele('ram:SpecifiedTradeSettlementLineMonetarySummation')
          .ele('ram:LineTotalAmount').txt(lineTotal).up()
        .up()
      .up()
    .up();
  });

  return doc.end({ prettyPrint: false });
}

// ── Embed XML dans PDF/A-3b via pdf-lib ──────────────────────────────────────
async function generateFacturXPDF(pdfBuffer, xmlString, invoiceNumber) {
  const pdfDoc  = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const xmlBytes = Buffer.from(xmlString, 'utf-8');

  // Embed le fichier XML comme EmbeddedFile (PDF/A-3b spec)
  const embeddedFile = await pdfDoc.attach(xmlBytes, 'factur-x.xml', {
    mimeType: 'text/xml',
    description: 'Factur-X invoice data',
    creationDate: new Date(),
    modificationDate: new Date(),
  });

  // XMP metadata PDF/A-3b obligatoire
  const xmpMeta = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  pdfDoc.setTitle(`Facture ${invoiceNumber}`);
  pdfDoc.setCreator('FacturePilot AI');
  pdfDoc.setProducer('FacturePilot AI — pdf-lib');

  return pdfDoc.save();
}

module.exports = { buildFacturXML, generateFacturXPDF };
