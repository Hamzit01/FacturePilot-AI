/* FacturePilot AI — Data Layer (API + localStorage cache) */
'use strict';

const FP = (() => {

  // ─── STORAGE HELPERS ─────────────────────────────────────────────────────────
  const get = (key, def = []) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? def; }
    catch { return def; }
  };
  const set = (key, val) => localStorage.setItem(key, JSON.stringify(val));

  // ─── API FETCH HELPER ─────────────────────────────────────────────────────────
  const apiFetch = async (path, opts = {}) => {
    const token = localStorage.getItem('fp_token');
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e = new Error(err.error || 'Erreur serveur');
      e.status = res.status;
      throw e;
    }
    return res;
  };

  // ─── AUTH ─────────────────────────────────────────────────────────────────────
  const login = async (email, password) => {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    localStorage.setItem('fp_token', data.token);
    localStorage.setItem('fp_logged', '1');
    set('fp_user', data.user);
    await sync();
    return data;
  };

  const logout = () => {
    ['fp_token', 'fp_logged', 'fp_user', 'fp_clients', 'fp_invoices'].forEach(k =>
      localStorage.removeItem(k)
    );
    window.location.href = 'index.html';
  };

  // ─── SYNC — hydrate localStorage from API ─────────────────────────────────────
  let _activePage = null;
  const sync = async () => {
    const token = localStorage.getItem('fp_token');
    if (!token) return;
    try {
      const [me, clients, invoices] = await Promise.all([
        apiFetch('/api/me').then(r => r.json()),
        apiFetch('/api/clients').then(r => r.json()),
        apiFetch('/api/invoices').then(r => r.json()),
      ]);
      set('fp_user', me);
      set('fp_clients', clients);
      set('fp_invoices', invoices);
      if (_activePage) renderSidebar(_activePage);
    } catch (err) {
      if (err.status === 401) {
        localStorage.removeItem('fp_token');
        localStorage.removeItem('fp_logged');
        window.location.href = 'login.html';
      }
    }
  };

  // ─── AUTH GUARD ───────────────────────────────────────────────────────────────
  const PUBLIC_PAGES = new Set(['', 'index.html', 'login.html', 'register.html']);
  const requireAuth = () => {
    const page = location.pathname.split('/').pop() || 'index.html';
    if (PUBLIC_PAGES.has(page)) return true;
    if (!localStorage.getItem('fp_token')) {
      window.location.href = 'login.html';
      return false;
    }
    return true;
  };

  // ─── CLIENTS ──────────────────────────────────────────────────────────────────
  const getClients = () => get('fp_clients', []);
  const saveClients = (data) => set('fp_clients', data);
  const getClient = (id) => getClients().find(c => String(c.id) === String(id));

  const addClient = (c) => {
    const tempId = 'tmp_' + Date.now();
    const newC = { ...c, id: tempId, createdAt: new Date().toISOString().split('T')[0] };
    saveClients([...getClients(), newC]);
    apiFetch('/api/clients', { method: 'POST', body: JSON.stringify(c) })
      .then(r => r.json())
      .then(real => {
        saveClients(getClients().map(x => String(x.id) === tempId ? real : x));
      })
      .catch(err => {
        saveClients(getClients().filter(x => String(x.id) !== tempId));
        toast(err.message, 'error');
      });
    return newC;
  };

  const updateClient = (id, data) => {
    saveClients(getClients().map(c => String(c.id) === String(id) ? { ...c, ...data } : c));
    apiFetch(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify(data) })
      .catch(err => toast(err.message, 'error'));
  };

  const deleteClient = (id) => {
    saveClients(getClients().filter(c => String(c.id) !== String(id)));
    apiFetch(`/api/clients/${id}`, { method: 'DELETE' })
      .catch(err => toast(err.message, 'error'));
  };

  // ─── INVOICES ─────────────────────────────────────────────────────────────────
  const getInvoices = () => get('fp_invoices', []);
  const saveInvoices = (data) => set('fp_invoices', data);
  const getInvoice = (id) => getInvoices().find(i => String(i.id) === String(id));

  const addInvoice = (inv) => {
    const tempId = 'tmp_' + Date.now();
    const newI = { ...inv, id: tempId, factureX: true, relances: [] };
    if (!newI.numero) newI.numero = nextInvoiceNum();
    saveInvoices([...getInvoices(), newI]);
    apiFetch('/api/invoices', { method: 'POST', body: JSON.stringify(inv) })
      .then(r => r.json())
      .then(real => {
        saveInvoices(getInvoices().map(x => String(x.id) === tempId ? real : x));
        if (_activePage) renderSidebar(_activePage);
      })
      .catch(err => {
        saveInvoices(getInvoices().filter(x => String(x.id) !== tempId));
        toast(err.message, 'error');
      });
    return newI;
  };

  const updateInvoice = (id, data) => {
    saveInvoices(getInvoices().map(i => String(i.id) === String(id) ? { ...i, ...data } : i));
    // Use PATCH for status-only changes, PUT for full updates
    if (Object.keys(data).length === 1 && 'statut' in data) {
      apiFetch(`/api/invoices/${id}/statut`, {
        method: 'PATCH',
        body: JSON.stringify({ statut: data.statut }),
      }).catch(err => toast(err.message, 'error'));
    } else {
      const inv = getInvoice(id);
      if (!inv) return;
      apiFetch(`/api/invoices/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          clientId: inv.clientId, clientNom: inv.clientNom,
          numero: inv.numero, objet: inv.objet,
          lignes: inv.lignes || '',
          montantHT: inv.montantHT, tva: inv.tva, montantTTC: inv.montantTTC,
          dateEmission: inv.dateEmission, dateEcheance: inv.dateEcheance,
          statut: inv.statut, notes: inv.notes || '',
        }),
      }).catch(err => toast(err.message, 'error'));
    }
  };

  const deleteInvoice = (id) => {
    saveInvoices(getInvoices().filter(i => String(i.id) !== String(id)));
    apiFetch(`/api/invoices/${id}`, { method: 'DELETE' })
      .catch(err => toast(err.message, 'error'));
  };

  const addRelance = (invoiceId, relance) => {
    const inv = getInvoice(invoiceId);
    if (!inv) return;
    const tempId = 'tmp_r' + Date.now();
    const newR = {
      id: tempId,
      type: relance.type || 'email',
      ton: relance.ton || 'cordial',
      message: relance.message || '',
      date: new Date().toISOString().split('T')[0],
      statut: 'envoyée',
    };
    // Optimistic: add to relances array in localStorage
    saveInvoices(getInvoices().map(i =>
      String(i.id) === String(invoiceId)
        ? { ...i, relances: [...(i.relances || []), newR] }
        : i
    ));
    apiFetch(`/api/invoices/${invoiceId}/relances`, {
      method: 'POST',
      body: JSON.stringify({ type: newR.type, ton: newR.ton, message: newR.message }),
    })
      .then(r => r.json())
      .then(real => {
        saveInvoices(getInvoices().map(i => {
          if (String(i.id) !== String(invoiceId)) return i;
          return {
            ...i,
            relances: (i.relances || []).map(r => String(r.id) === tempId ? real : r),
          };
        }));
      })
      .catch(err => toast(err.message, 'error'));
  };

  // ─── USER ─────────────────────────────────────────────────────────────────────
  const DEFAULT_USER = {
    prenom: '', nom: '', email: '', entreprise: '', siren: '',
    tva: '', adresse: '', tel: '', iban: '', bic: '',
    plan: 'essentiel', logo: null, couleurFacture: '#1B3A4B',
  };
  const getUser = () => get('fp_user', DEFAULT_USER);
  const saveUser = (data) => {
    const merged = { ...getUser(), ...data };
    set('fp_user', merged);
    if (localStorage.getItem('fp_token')) {
      return apiFetch('/api/me', { method: 'PUT', body: JSON.stringify(merged) })
        .then(r => r.json())
        .then(updated => { set('fp_user', { ...merged, ...updated }); return updated; })
        .catch(err => { toast(err.message, 'error'); throw err; });
    }
    return Promise.resolve(merged);
  };

  // ─── KPI CALCULATIONS ─────────────────────────────────────────────────────────
  const getKPIs = () => {
    const invs = getInvoices();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const caMonth   = invs.filter(i => new Date(i.dateEmission) >= monthStart).reduce((s,i) => s + i.montantTTC, 0);
    const encours   = invs.filter(i => ['envoyee','retard'].includes(i.statut)).reduce((s,i) => s + i.montantTTC, 0);
    const retard    = invs.filter(i => i.statut === 'retard').reduce((s,i) => s + i.montantTTC, 0);
    const payees    = invs.filter(i => i.statut === 'payee').reduce((s,i) => s + i.montantTTC, 0);
    const total     = invs.reduce((s,i) => s + i.montantTTC, 0);
    const retardCount = invs.filter(i => i.statut === 'retard').length;
    const tauxRecouvrement = total > 0 ? Math.round((payees / total) * 100) : 0;
    return { caMonth, encours, retard, tauxRecouvrement, retardCount, totalInvoices: invs.length };
  };

  // ─── FORMAT HELPERS ───────────────────────────────────────────────────────────
  const money = (n) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' €';
  const dateStr = (s) => s ? new Date(s).toLocaleDateString('fr-FR') : '—';
  const daysLate = (dateEcheance) => Math.floor((Date.now() - new Date(dateEcheance).getTime()) / (1000*60*60*24));
  const daysUntil = (dateEcheance) => Math.floor((new Date(dateEcheance).getTime() - Date.now()) / (1000*60*60*24));

  // ─── STATUS HELPERS ───────────────────────────────────────────────────────────
  const statusLabel = { payee:'Payée', envoyee:'Envoyée', retard:'En retard', brouillon:'Brouillon' };
  const statusClass = { payee:'badge-paid', envoyee:'badge-sent', retard:'badge-overdue', brouillon:'badge-draft' };
  const risqueClass = { faible:'badge-paid', moyen:'badge-pending', élevé:'badge-overdue' };

  // ─── NEXT INVOICE NUMBER ──────────────────────────────────────────────────────
  const nextInvoiceNum = () => {
    const invs = getInvoices();
    const year = new Date().getFullYear();
    const nums = invs.map(i => {
      const m = i.numero ? i.numero.match(/FA-(\d{4})-(\d+)/) : null;
      return m && parseInt(m[1]) === year ? parseInt(m[2]) : 0;
    });
    return `FA-${year}-${String(Math.max(0, ...nums) + 1).padStart(3,'0')}`;
  };

  // ─── FACTUR-X XML GENERATION ─────────────────────────────────────────────────
  const generateFacturX = (inv) => {
    const user = getUser();
    const client = getClient(inv.clientId) || { nom: inv.clientNom, siret:'', adresse:'' };
    return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:factur-x.eu:1p0:en16931</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${inv.numero}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${(inv.dateEmission||'').replace(/-/g,'')}</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${user.entreprise}</ram:Name>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${user.tva||''}</ram:ID>
        </ram:SpecifiedTaxRegistration>
        <ram:PostalTradeAddress>
          <ram:LineOne>${user.adresse||''}</ram:LineOne>
          <ram:CountryID>FR</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${client.nom}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:LineOne>${client.adresse||''}</ram:LineOne>
          <ram:CountryID>FR</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${(inv.dateEcheance||'').replace(/-/g,'')}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${Number(inv.montantHT).toFixed(2)}</ram:LineTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${(Number(inv.montantTTC)-Number(inv.montantHT)).toFixed(2)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${Number(inv.montantTTC).toFixed(2)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${Number(inv.montantTTC).toFixed(2)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
    ${(() => {
      let rows;
      try { rows = inv.lignes ? JSON.parse(inv.lignes) : null; } catch(e) { rows = null; }
      if (!rows || !rows.length) rows = [{ description: inv.objet || '', qte: 1, prixHT: inv.montantHT }];
      return rows.map((l, i) => `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${i + 1}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${l.description || inv.objet}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${Number(l.prixHT).toFixed(2)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">${Number(l.qte).toFixed(2)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${(Number(l.prixHT) * Number(l.qte)).toFixed(2)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`).join('\n');
    })()}
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
  };

  // ─── AI RELANCE MESSAGES ─────────────────────────────────────────────────────
  const getRelanceMessage = (inv, ton, canal) => {
    const user = getUser();
    const late = daysLate(inv.dateEcheance);
    const montant = money(inv.montantTTC);
    const msgs = {
      cordial: `Bonjour,\n\nJ'espère que vous allez bien. Je me permets de vous contacter au sujet de la facture ${inv.numero} d'un montant de ${montant}, dont l'échéance était fixée au ${dateStr(inv.dateEcheance)}.\n\nÀ ce jour, il semble que ce règlement n'ait pas encore été effectué. S'agit-il d'un simple oubli ? Pourriez-vous me confirmer la date à laquelle ce paiement sera effectué ?\n\nJe reste à votre disposition pour tout renseignement.\n\nCordialement,\n${user.prenom} ${user.nom}\n${user.entreprise}`,
      ferme: `Madame, Monsieur,\n\nMalgré mon précédent contact, la facture ${inv.numero} d'un montant de ${montant} reste impayée — soit ${late} jours de retard.\n\nJe vous mets formellement en demeure de régler cette somme dans les 5 jours ouvrés. À défaut, je serai contraint(e) d'engager une procédure de recouvrement incluant des pénalités de retard (taux BCE + 10 pts) et une indemnité forfaitaire de 40 €.\n\nCordialement,\n${user.prenom} ${user.nom}`,
      urgent: `RAPPEL URGENT — Facture impayée\n\nLa facture ${inv.numero} (${montant}) est en retard de ${late} jours.\n\nDes pénalités de retard s'appliquent d'ores et déjà (taux légal BCE + 10 pts) ainsi qu'une indemnité forfaitaire de recouvrement de 40 €.\n\nMerci de régulariser cette situation dans les 48 heures.\n\n${user.prenom} ${user.nom} — ${user.entreprise}`,
      'mise en demeure': `MISE EN DEMEURE\n\nPar la présente, ${user.entreprise}, représentée par ${user.prenom} ${user.nom}, met formellement en demeure votre société de régler la somme de ${montant} correspondant à la facture ${inv.numero} émise le ${dateStr(inv.dateEmission)}.\n\nÀ défaut de règlement dans un délai de 8 jours à compter de la réception de ce courrier, un dossier contentieux sera constitué et transmis à un huissier de justice pour recouvrement forcé.\n\nFait le ${dateStr(new Date().toISOString())}.\n${user.prenom} ${user.nom}`,
    };
    const sms = {
      cordial: `Bonjour, facture ${inv.numero} (${montant}) échue le ${dateStr(inv.dateEcheance)} — merci de confirmer votre règlement. ${user.entreprise}`,
      ferme: `RAPPEL — Facture ${inv.numero} : ${montant} impayée depuis ${late} jours. Règlement sous 5 jours. ${user.entreprise}`,
      urgent: `URGENT — Facture ${inv.numero} : ${montant} impayée. Pénalités en cours. Régularisez sous 48h. ${user.prenom} ${user.nom}`,
      'mise en demeure': `MISE EN DEMEURE — Facture ${inv.numero} : ${montant}. Sans règlement sous 8 jours, procédure judiciaire engagée. ${user.entreprise}`,
    };
    return canal === 'sms' ? (sms[ton] || sms.cordial) : (msgs[ton] || msgs.cordial);
  };

  // ─── TOAST NOTIFICATION ───────────────────────────────────────────────────────
  const toast = (msg, type = 'success') => {
    let el = document.getElementById('fp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fp-toast';
      el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1B3A4B;color:white;padding:14px 20px;border-radius:12px;font-size:.88rem;font-weight:600;box-shadow:0 6px 32px rgba(0,0,0,.2);z-index:9999;transition:all .3s;display:flex;align-items:center;gap:10px;transform:translateY(80px);opacity:0;max-width:360px;';
      document.body.appendChild(el);
    }
    const colors = { success:'#1A7A3D', error:'#B8352A', info:'#D4853B' };
    el.innerHTML = `<span style="color:${colors[type]||colors.success};font-size:1.1rem">${type==='error'?'✗':type==='info'?'ℹ':'✓'}</span><span>${msg}</span>`;
    el.style.transform = 'translateY(0)'; el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.transform='translateY(80px)'; el.style.opacity='0'; }, 3500);
  };

  // ─── CONFIRM DIALOG ───────────────────────────────────────────────────────────
  const confirm = (msg, onOk) => {
    let overlay = document.getElementById('fp-confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'fp-confirm-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div style="background:white;border-radius:16px;padding:28px;max-width:380px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.2);">
      <h3 style="font-size:1rem;color:#1B3A4B;margin-bottom:10px;">Confirmation</h3>
      <p style="font-size:.9rem;color:#6b7a8a;margin-bottom:24px;">${msg}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="fp-confirm-cancel" style="padding:9px 18px;border-radius:8px;border:1px solid #CDD5DE;background:#F4F7FA;font-size:.9rem;font-weight:600;cursor:pointer;color:#6b7a8a;">Annuler</button>
        <button id="fp-confirm-ok" style="padding:9px 18px;border-radius:8px;border:none;background:#B8352A;color:white;font-size:.9rem;font-weight:600;cursor:pointer;">Confirmer</button>
      </div>
    </div>`;
    overlay.style.display = 'flex';
    document.getElementById('fp-confirm-cancel').onclick = () => overlay.style.display='none';
    document.getElementById('fp-confirm-ok').onclick = () => { overlay.style.display='none'; onOk(); };
  };

  // ─── SIDEBAR RENDER ───────────────────────────────────────────────────────────
  const renderSidebar = (activePage) => {
    _activePage = activePage;
    const user = getUser();
    const kpi  = getKPIs();
    const ini  = ((user.prenom||'?')[0]+(user.nom||'?')[0]).toUpperCase();
    const nav = (page, href, icon, label, badge='') => `
      <a class="nav-item ${activePage===page?'active':''}" href="${href}">
        <svg viewBox="0 0 24 24" fill="currentColor">${icon}</svg>${label}${badge?`<span class="nav-badge">${badge}</span>`:''}
      </a>`;
    const html = `
      <a class="sidebar-logo" href="dashboard.html" style="text-decoration:none;cursor:pointer">
        <div class="logo-icon"><svg viewBox="0 0 24 24" fill="white"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg></div>
        <div class="logo-text">Facture<span>Pilot</span> AI</div>
      </a>
      <div class="sidebar-section">Principal</div>
      ${nav('dashboard','dashboard.html','<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>','Tableau de bord')}
      ${nav('factures','factures.html','<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>','Mes factures',kpi.retardCount||'')}
      ${nav('clients','clients.html','<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>','Clients')}
      <div class="sidebar-section">Recouvrement IA</div>
      ${nav('relances','relances.html','<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>','Relances IA',kpi.retardCount||'')}
      ${nav('encours','encours.html','<path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/>','Encours & analytics')}
      <div class="sidebar-section">Compte</div>
      ${nav('settings','settings.html','<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>','Paramètres')}
      <a class="nav-item" href="guide-utilisateur.html" target="_blank" style="font-size:.8rem;color:var(--text-muted);opacity:.8">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/></svg>
        📘 Guide utilisateur
      </a>
      <div class="sidebar-footer">
        <div class="user-row">
          <div class="user-avatar">${ini}</div>
          <div class="user-info">
            <div class="name">${user.prenom||''} ${user.nom||''}</div>
            <div class="plan">Plan ${(user.plan||'essentiel').toUpperCase()} · ${user.entreprise||''}</div>
          </div>
        </div>
        <a href="index.html" onclick="event.preventDefault();FP.logout()"
           style="display:flex;align-items:center;justify-content:center;gap:7px;width:100%;margin-top:10px;padding:8px 12px;border-radius:8px;color:var(--text-muted);font-size:.82rem;font-weight:600;cursor:pointer;text-decoration:none;border:1.5px solid var(--border);transition:all .2s;box-sizing:border-box"
           onmouseover="this.style.background='rgba(184,53,42,.07)';this.style.color='#b8352a';this.style.borderColor='rgba(184,53,42,.25)'"
           onmouseout="this.style.background='';this.style.color='var(--text-muted)';this.style.borderColor='var(--border)'">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>
          Se déconnecter
        </a>
      </div>
    `;
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.innerHTML = html;
  };

  // ─── MODAL HELPERS ────────────────────────────────────────────────────────────
  const openModal  = (id) => { const m=document.getElementById(id); if(m) m.classList.add('open'); };
  const closeModal = (id) => { const m=document.getElementById(id); if(m) m.classList.remove('open'); };

  // ─── INIT ─────────────────────────────────────────────────────────────────────
  const init = () => {
    if (!requireAuth()) return;
    sync(); // background sync — updates cache + sidebar when done
    // Raccourci global Escape pour fermer les modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay').forEach(m => {
          if (m.style.display === 'flex') m.style.display = 'none';
          m.classList.remove('open');
        });
      }
    });
  };

  // ─── EXPORT ──────────────────────────────────────────────────────────────────
  return {
    // Auth
    login, logout, sync,
    // Clients
    getClients, saveClients, getClient, addClient, updateClient, deleteClient,
    // Invoices
    getInvoices, saveInvoices, getInvoice, addInvoice, updateInvoice, deleteInvoice, addRelance,
    // User
    getUser, saveUser,
    // API helper — returns parsed JSON, throws on error
    api: async (path, opts) => apiFetch(path, opts).then(r => r.json()),
    // KPIs & utils
    getKPIs, nextInvoiceNum,
    money, dateStr, daysLate, daysUntil,
    statusLabel, statusClass, risqueClass,
    // Documents & AI
    generateFacturX, getRelanceMessage,
    // UI
    toast, confirm, renderSidebar, openModal, closeModal,
    // Bootstrap
    init,
  };
})();

document.addEventListener('DOMContentLoaded', () => FP.init());

// PWA Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
