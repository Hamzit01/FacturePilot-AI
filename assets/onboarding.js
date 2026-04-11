'use strict';
/**
 * FacturePilot AI — Onboarding Manager
 * ──────────────────────────────────────────────────────────────────────────
 * Vanilla JS pur, zéro dépendance externe.
 * Persistance : localStorage ('fp_onboarding_step', 'fp_onboarding_dismissed')
 * Usage : inclure ce script APRÈS app.js dans dashboard.html, factures.html,
 *         relances.html → FPOnboarding.init() s'appelle automatiquement.
 */
const FPOnboarding = (() => {

  // ── Clés localStorage ──────────────────────────────────────────────────────
  const LS_STEP      = 'fp_onboarding_step';      // dernière étape complétée (0–3)
  const LS_DISMISSED = 'fp_onboarding_dismissed'; // '1' si l'utilisateur a tout passé

  // ── Définition des étapes ──────────────────────────────────────────────────
  // page    : nom de fichier HTML où cette étape doit s'afficher
  // target  : sélecteur CSS de l'élément mis en avant
  // pos     : position de la bulle (bottom | top | right | left)
  const STEPS = [
    {
      id:     1,
      page:   'dashboard.html',
      target: '#kpi-grid',
      pos:    'bottom',
      title:  '👋 Bienvenue sur FacturePilot AI !',
      text:   'Prêt à diviser tes délais de paiement par 2 ? Ces 4 indicateurs clés suivent ton CA, tes encours, tes retards et ton taux de recouvrement — en temps réel.',
    },
    {
      id:     2,
      page:   'factures.html',
      target: '#inv-table',
      pos:    'top',
      title:  '📄 Factures Factur-X EN 16931',
      text:   'Ici, vos factures sont automatiquement transformées en Factur-X, le format légal obligatoire à partir de septembre 2026. Téléchargez le PDF enrichi en un clic — zéro configuration.',
    },
    {
      id:     3,
      page:   'relances.html',
      target: '#relance-list',
      pos:    'top',
      title:  '🤖 L\'IA travaille pour vous',
      text:   'C\'est ici que l\'IA rédige vos relances selon le profil de risque du client. Ton courtois, ferme, urgent ou mise en demeure — choisi automatiquement selon les jours de retard.',
    },
  ];

  // ── État interne ───────────────────────────────────────────────────────────
  let _step      = null; // étape en cours de rendu
  let _overlay   = null;
  let _tooltip   = null;
  let _resizeFn  = null;

  const getStep     = ()    => parseInt(localStorage.getItem(LS_STEP) || '0', 10);
  const setStep     = (n)   => localStorage.setItem(LS_STEP, String(n));
  const isDismissed = ()    => localStorage.getItem(LS_DISMISSED) === '1';
  const dismiss     = ()    => { localStorage.setItem(LS_DISMISSED, '1'); _teardown(); };

  // ── Création du DOM ────────────────────────────────────────────────────────
  function _buildDOM() {
    // Overlay semi-transparent (clic dessus = skip)
    _overlay = document.createElement('div');
    _overlay.className = 'ob-overlay';
    _overlay.id = 'ob-overlay';
    _overlay.addEventListener('click', dismiss);

    // Anneau spotlight (suit l'élément cible)
    const ring = document.createElement('div');
    ring.className = 'ob-spotlight-ring';
    ring.id = 'ob-spotlight-ring';
    _overlay.appendChild(ring);

    // Bulle tooltip
    _tooltip = document.createElement('div');
    _tooltip.className = 'ob-tooltip';
    _tooltip.id = 'ob-tooltip';
    // Empêcher le clic sur la bulle de fermer l'overlay
    _tooltip.addEventListener('click', e => e.stopPropagation());

    document.body.appendChild(_overlay);
    document.body.appendChild(_tooltip);

    document.addEventListener('keydown', _handleEsc);
  }

  function _teardown() {
    _overlay?.remove();  _overlay = null;
    _tooltip?.remove();  _tooltip = null;
    document.querySelectorAll('.ob-highlight').forEach(el => {
      el.classList.remove('ob-highlight');
      el.style.removeProperty('position');
      el.style.removeProperty('z-index');
    });
    document.removeEventListener('keydown', _handleEsc);
    if (_resizeFn) { window.removeEventListener('resize', _resizeFn); _resizeFn = null; }
  }

  function _handleEsc(e) { if (e.key === 'Escape') dismiss(); }

  // ── Rendu d'une étape ──────────────────────────────────────────────────────
  function _renderStep(step) {
    _step = step;

    const target = document.querySelector(step.target);
    if (!target) { _advance(); return; } // élément absent → passer

    // ── Contenu de la bulle ───────────────────────────────────────────────
    _tooltip.innerHTML = `
      <div class="ob-step-tag">Étape ${step.id} sur ${STEPS.length}</div>
      <h4 class="ob-title">${step.title}</h4>
      <p class="ob-text">${step.text}</p>
      <div class="ob-actions">
        <button class="ob-btn-next" id="ob-next">
          ${step.id < STEPS.length ? 'Suivant →' : 'Terminer ✓'}
        </button>
        <button class="ob-btn-skip" id="ob-skip">Passer le tutoriel</button>
      </div>
      <div class="ob-dots">
        ${STEPS.map((_, i) => `
          <span class="ob-dot
            ${i < step.id - 1 ? 'done' : ''}
            ${i === step.id - 1 ? 'active' : ''}
          "></span>`).join('')}
      </div>
    `;

    _tooltip.dataset.pos = step.pos;
    _tooltip.classList.add('ob-anim-in');
    _tooltip.addEventListener('animationend', () => _tooltip.classList.remove('ob-anim-in'), { once: true });

    // Mise en avant de l'élément cible
    document.querySelectorAll('.ob-highlight').forEach(el => el.classList.remove('ob-highlight'));
    target.classList.add('ob-highlight');

    // Position bulle + spotlight
    _positionAll(target, step.pos);

    // Repositionnement au resize
    if (_resizeFn) window.removeEventListener('resize', _resizeFn);
    _resizeFn = () => _positionAll(target, step.pos);
    window.addEventListener('resize', _resizeFn, { passive: true });

    // Events boutons
    document.getElementById('ob-next').onclick = _advance;
    document.getElementById('ob-skip').onclick = dismiss;
  }

  // ── Positionnement bulle + anneau ──────────────────────────────────────────
  function _positionAll(target, pos) {
    requestAnimationFrame(() => {
      _positionTooltip(_tooltip, target, pos);
      _positionSpotlight(document.getElementById('ob-spotlight-ring'), target);
    });
  }

  function _positionTooltip(tooltip, target, pos) {
    const tr  = target.getBoundingClientRect();
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    const tw  = tooltip.offsetWidth  || 320;
    const th  = tooltip.offsetHeight || 180;
    const GAP = 18; // distance entre l'élément et la bulle
    const PAD = 14; // marge avec les bords de l'écran
    let top, left;

    switch (pos) {
      case 'bottom':
        top  = tr.bottom + GAP;
        left = tr.left + tr.width / 2 - tw / 2;
        break;
      case 'top':
        top  = tr.top - th - GAP;
        left = tr.left + tr.width / 2 - tw / 2;
        break;
      case 'right':
        top  = tr.top + tr.height / 2 - th / 2;
        left = tr.right + GAP;
        break;
      case 'left':
        top  = tr.top + tr.height / 2 - th / 2;
        left = tr.left - tw - GAP;
        break;
      default:
        top  = tr.bottom + GAP;
        left = tr.left + tr.width / 2 - tw / 2;
    }

    // Clamping : rester dans le viewport
    left = Math.max(PAD, Math.min(left, vw - tw - PAD));
    top  = Math.max(PAD, Math.min(top,  vh - th - PAD));

    tooltip.style.top  = top  + 'px';
    tooltip.style.left = left + 'px';
  }

  function _positionSpotlight(ring, target) {
    if (!ring) return;
    const tr  = target.getBoundingClientRect();
    const PAD = 10;
    ring.style.top    = (tr.top    - PAD) + 'px';
    ring.style.left   = (tr.left   - PAD) + 'px';
    ring.style.width  = (tr.width  + PAD * 2) + 'px';
    ring.style.height = (tr.height + PAD * 2) + 'px';
  }

  // ── Avancer à l'étape suivante ─────────────────────────────────────────────
  function _advance() {
    const completedId = _step?.id || 0;
    setStep(completedId); // marquer cette étape comme complétée

    const nextId   = completedId + 1;
    const nextStep = STEPS.find(s => s.id === nextId);

    if (!nextStep) { dismiss(); return; } // toutes les étapes vues → fin

    // Page différente → naviguer
    const curPage = location.pathname.split('/').pop() || 'index.html';
    if (curPage !== nextStep.page && nextStep.page !== curPage) {
      _teardown();
      window.location.href = nextStep.page;
    } else {
      // Même page (peu probable mais géré)
      _teardown();
      _buildDOM();
      _renderStep(nextStep);
    }
  }

  // ── Initialisation (appelée automatiquement) ───────────────────────────────
  function init() {
    // Pas d'onboarding si : déjà vu, utilisateur non connecté, 1ère connexion seulement
    if (isDismissed()) return;
    if (!localStorage.getItem('fp_token')) return;

    const done  = getStep();                       // dernière étape complétée
    const page  = location.pathname.split('/').pop() || 'index.html';
    const step  = STEPS.find(s => s.id === done + 1 && s.page === page);

    if (!step) return;

    // Délai d'attente : laisser la page se rendre (plus long pour le dashboard)
    const delay = done === 0 ? 1400 : 600;
    setTimeout(() => {
      // Vérifier que l'élément est bien là avant d'afficher
      if (!document.querySelector(step.target)) return;
      _buildDOM();
      _renderStep(step);
    }, delay);
  }

  // ── API publique ───────────────────────────────────────────────────────────
  return { init, dismiss, getStep, setStep, reset: () => { localStorage.removeItem(LS_STEP); localStorage.removeItem(LS_DISMISSED); } };
})();

// ── Auto-init ─────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', FPOnboarding.init);
} else {
  setTimeout(FPOnboarding.init, 200);
}
