'use strict';
/**
 * Validateurs SIREN / SIRET — Zéro Garbage Data
 * ─────────────────────────────────────────────────────────────────────────────
 * SIREN  : 9 chiffres exactement  (INSEE)
 * SIRET  : 14 chiffres exactement (SIREN 9 + NIC 5)
 * Luhn   : algorithme de Luhn adapté (somme des chiffres pondérés ≡ 0 mod 10)
 *
 * Comportement :
 *   - Champ vide / undefined → valide (SIREN/SIRET optionnel pour un client)
 *   - Valeur non numérique ou mauvaise longueur → erreur explicite
 *   - Checksum invalide → warning (non bloquant, certains SIREN légitimes échouent)
 */

// ── Algorithme de Luhn (variante INSEE) ──────────────────────────────────────
function luhnISEE(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = parseInt(digits[i], 10);
    // Position paire depuis la droite (0-indexed) → doubler
    if ((digits.length - 1 - i) % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// ── validateSIREN ─────────────────────────────────────────────────────────────
/**
 * @param {string|undefined} value
 * @returns {{ valid: boolean, error?: string, warning?: string }}
 */
function validateSIREN(value) {
  if (!value || value.trim() === '') return { valid: true }; // optionnel

  const clean = value.replace(/[\s.]/g, '');

  if (!/^\d{9}$/.test(clean)) {
    return {
      valid: false,
      error: `SIREN invalide : doit contenir exactement 9 chiffres (reçu : "${value.trim()}")`,
    };
  }

  if (!luhnISEE(clean)) {
    // Pas bloquant — certains SIREN historiques échouent le checksum Luhn
    return {
      valid: true,
      warning: `SIREN ${clean} : checksum Luhn incorrect (peut être un SIREN historique)`,
    };
  }

  return { valid: true };
}

// ── validateSIRET ─────────────────────────────────────────────────────────────
/**
 * @param {string|undefined} value
 * @returns {{ valid: boolean, error?: string, warning?: string }}
 */
function validateSIRET(value) {
  if (!value || value.trim() === '') return { valid: true }; // optionnel

  const clean = value.replace(/[\s.]/g, '');

  if (!/^\d{14}$/.test(clean)) {
    return {
      valid: false,
      error: `SIRET invalide : doit contenir exactement 14 chiffres (reçu : "${value.trim()}")`,
    };
  }

  // Les 9 premiers chiffres = SIREN → valider aussi le SIREN embarqué
  const sirenResult = validateSIREN(clean.slice(0, 9));
  if (!sirenResult.valid) {
    return {
      valid: false,
      error: `SIRET invalide : SIREN embarqué incorrect — ${sirenResult.error}`,
    };
  }

  if (!luhnISEE(clean)) {
    return {
      valid: true,
      warning: `SIRET ${clean} : checksum Luhn incorrect (peut être un établissement historique)`,
    };
  }

  return { valid: true };
}

// ── validateClientBody ────────────────────────────────────────────────────────
/**
 * Valide req.body pour POST/PUT /api/clients
 * @param {object} body
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateClientBody(body) {
  const errors = [];
  const warnings = [];

  const { nom, siret, email, tel } = body;

  // Nom obligatoire
  if (!nom || !nom.trim()) errors.push('Le nom du client est requis');
  else if (nom.trim().length > 200) errors.push('Le nom ne peut pas dépasser 200 caractères');

  // SIRET (contient le SIREN — on valide SIRET en priorité)
  if (siret) {
    const clean = siret.replace(/[\s.]/g, '');
    if (clean.length === 14) {
      const r = validateSIRET(siret);
      if (!r.valid) errors.push(r.error);
      else if (r.warning) warnings.push(r.warning);
    } else if (clean.length === 9) {
      // Accepter un SIREN seul dans le champ SIRET (cas fréquent)
      const r = validateSIREN(siret);
      if (!r.valid) errors.push(r.error);
      else if (r.warning) warnings.push(r.warning);
    } else if (clean.length > 0) {
      errors.push(`SIRET invalide : 9 (SIREN) ou 14 chiffres attendus, ${clean.length} reçu`);
    }
  }

  // Email — format basique (not exhaustive, évite le garbage évident)
  if (email && email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
    errors.push(`Email invalide : "${email.trim()}"`);
  }

  // Téléphone — au moins 8 chiffres (FR/international)
  if (tel && tel.trim() && !/^[+\d\s()\-\.]{8,20}$/.test(tel.trim())) {
    errors.push(`Numéro de téléphone invalide : "${tel.trim()}"`);
  }

  return { errors, warnings };
}

module.exports = { validateSIREN, validateSIRET, validateClientBody };
