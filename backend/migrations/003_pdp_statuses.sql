-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003 — Cycle de vie PDP (Plateforme de Dématérialisation Partenaire)
-- Réforme facturation électronique 2026 — Ordonnance n°2021-1190
-- ─────────────────────────────────────────────────────────────────────────────
-- Valeurs officielles du cycle de vie B2B (art. 290 CGI modifié) :
--   deposee    → facture transmise à la PDP, en attente de traitement
--   rejetee    → rejetée par la PDP (erreur technique/format)
--   refusee    → refusée par l'acheteur (litige, facture incorrecte)
--   approuvee  → acceptée par l'acheteur (implicitement ou explicitement)
--   encaissee  → paiement reçu et rapproché (statut CHORUS requis)
-- NULL = mode hors-PDP (avant activation, ou plan essentiel sans PDP)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Création du type ENUM (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'pdp_status'
  ) THEN
    CREATE TYPE pdp_status AS ENUM (
      'deposee',
      'rejetee',
      'refusee',
      'approuvee',
      'encaissee'
    );
  END IF;
END;
$$;

-- 2. Ajout de la colonne pdp_status sur invoices (idempotent)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS pdp_status  pdp_status   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pdp_sent_at TIMESTAMPTZ  DEFAULT NULL,  -- horodatage dépôt PDP
  ADD COLUMN IF NOT EXISTS pdp_ref     TEXT         DEFAULT NULL;  -- référence retour PDP

-- 3. Index partiel pour interroger rapidement les factures en transit PDP
CREATE INDEX IF NOT EXISTS idx_invoices_pdp_status
  ON invoices(user_id, pdp_status)
  WHERE pdp_status IS NOT NULL;

-- 4. Commentaires pour documentation schema
COMMENT ON COLUMN invoices.pdp_status  IS 'Statut cycle de vie PDP (réforme 2026) — NULL si hors-PDP';
COMMENT ON COLUMN invoices.pdp_sent_at IS 'Horodatage de dépôt sur la Plateforme de Dématérialisation Partenaire';
COMMENT ON COLUMN invoices.pdp_ref     IS 'Référence unique retournée par la PDP après dépôt';
