'use strict';
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// ─── HELPER: date offset ──────────────────────────────────────────────────────
const d = (offset = 0) => {
  const dt = new Date();
  dt.setDate(dt.getDate() + offset);
  return dt.toISOString().split('T')[0];
};

// ─── POOL PostgreSQL ──────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('[DB] ERREUR : DATABASE_URL non défini — vérifiez les variables d\'environnement Vercel');
}

// Sur Vercel (serverless), chaque Lambda démarre à froid — connexion courte obligatoire
// Supabase Transaction Pooler (port 6543) + pgbouncer=true = compatible serverless
const rawUrl  = process.env.DATABASE_URL || 'postgresql://localhost/facturepilot';
const dbUrl   = rawUrl.includes('?') ? rawUrl : `${rawUrl}?pgbouncer=true&connection_limit=1`;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000, // 10s max pour obtenir une connexion
  idleTimeoutMillis: 10000,       // libère la connexion après 10s d'inactivité
  max: 3,                         // max 3 connexions (serverless — pas de pool persistant)
  allowExitOnIdle: true,          // libère le process quand inactif (bon pour Lambda)
});

// ─── SEED: create demo user + data if DB is empty ────────────────────────────
async function seedDemo() {
  // Jamais en production — évite d'injecter des données fictives sur une DB vierge prod
  if (process.env.NODE_ENV === 'production' || process.env.SKIP_SEED === 'true') {
    console.log('[DB] Seed ignoré (production ou SKIP_SEED=true)');
    return;
  }
  const email = process.env.DEMO_EMAIL || 'demo@facturepilot.local';
  const pass  = process.env.DEMO_PASSWORD || 'demo1234';
  const hash  = bcrypt.hashSync(pass, 10);
  const { rows: [u] } = await pool.query(`
    INSERT INTO users (prenom,nom,email,password_hash,entreprise,siren,tva_num,adresse,tel,plan,couleur_facture)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
    ON CONFLICT (email) DO NOTHING
  `, ['Demo','User', email, hash,
      'FacturePilot Demo','123456789','FR12123456789',
      '12 rue de la Libération, 52100 Saint-Dizier',
      '06 00 00 00 00','pro','#1B3A4B']);
  if (!u) return; // Email already exists
  const uid = u.id;

  const clientsData = [
    [uid,'Agence Dupont','41234567800010','contact@agence-dupont.fr','03 25 12 34 56','12 rue de la Paix, 51100 Reims','Communication',30,'faible',d(-80)],
    [uid,'BTP Martin SARL','55678901200034','facturation@btpmartin.fr','03 25 87 65 43','8 avenue Gambetta, 52100 Saint-Dizier','BTP',45,'moyen',d(-70)],
    [uid,'Pharma Loire','78901234500056','compta@pharmaloire.fr','02 41 23 45 67','45 rue Nationale, 49000 Angers','Pharmacie',30,'faible',d(-60)],
    [uid,'Coiffure Élise','89012345600078','elise.dupuis@gmail.com','06 12 34 56 78','3 place de la Mairie, 52100 Saint-Dizier','Services',15,'élevé',d(-50)],
    [uid,'Cabinet RH Morin','12345678900090','morin@cabinetmorin.fr','03 25 45 67 89','18 rue Gambetta, 54000 Nancy','Conseil RH',30,'faible',d(-45)],
    [uid,'Auto-école Dupuis','23456789000012','auto-ecole@dupuis52.fr','03 25 31 22 11','7 rue du Général de Gaulle, 52100 Saint-Dizier','Formation',30,'moyen',d(-40)],
  ];

  const cids = [];
  for (const row of clientsData) {
    const { rows: [c] } = await pool.query(
      'INSERT INTO clients (user_id,nom,siret,email,tel,adresse,secteur,delai_paiement,risque,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      row
    );
    cids.push(c.id);
  }

  const invData = [
    [uid,cids[0],'Agence Dupont','FA-2026-001','Développement site web — T1 2026',2666.67,20,3200,d(-60),d(-30),'payee'],
    [uid,cids[5],'Auto-école Dupuis','FA-2026-002','Audit de conformité numérique',816.67,20,980,d(-45),d(-15),'brouillon'],
    [uid,cids[4],'Cabinet RH Morin','FA-2026-003','Formation gestion administrative',625,20,750,d(-7),d(23),'envoyee'],
    [uid,cids[2],'Pharma Loire','FA-2026-004','Intégration logiciel ERP — Phase 1',4500,20,5400,d(-3),d(27),'envoyee'],
    [uid,cids[3],'Coiffure Élise','FA-2026-005','Création site vitrine + référencement',208.33,20,250,d(-30),d(-8),'retard'],
    [uid,cids[1],'BTP Martin SARL','FA-2026-006','Conseil en gestion de flux — Q1 2026',1541.67,20,1850,d(-45),d(-14),'retard'],
    [uid,cids[0],'Agence Dupont','FA-2026-007','Maintenance mensuelle — Avril 2026',2666.67,20,3200,d(-1),d(29),'envoyee'],
  ];

  const iids = [];
  for (const row of invData) {
    const { rows: [inv] } = await pool.query(
      'INSERT INTO invoices (user_id,client_id,client_nom,numero,objet,montant_ht,tva,montant_ttc,date_emission,date_echeance,statut,facture_x) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1) RETURNING id',
      row
    );
    iids.push(inv.id);
  }

  // Relances for overdue invoices
  await pool.query('INSERT INTO relances (invoice_id,type,ton,statut,created_at) VALUES ($1,$2,$3,$4,$5)', [iids[4],'email','cordial','envoyée',d(-3)]);
  await pool.query('INSERT INTO relances (invoice_id,type,ton,statut,created_at) VALUES ($1,$2,$3,$4,$5)', [iids[5],'email','cordial','envoyée',d(-7)]);
  await pool.query('INSERT INTO relances (invoice_id,type,ton,statut,created_at) VALUES ($1,$2,$3,$4,$5)', [iids[5],'sms','ferme','envoyée',d(-2)]);

  console.log('✅  Base de données initialisée avec les données de démo');
}

// ─── Mise à jour automatique des statuts "retard" ────────────────────────────
async function updateOverdueStatuses() {
  const today = new Date().toISOString().split('T')[0];
  // bypassRLS : opération admin globale (pas de contexte user)
  // Disponible seulement après la définition de pool.bypassRLS plus bas
  // → on utilise pool.query() ici (appelé avant que bypassRLS soit défini)
  // En prod avec FORCE RLS actif (migration 004), cette fonction sera wrappée
  // dans un BEGIN + set_config bypass + COMMIT directement via client
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    const result = await client.query(`
      UPDATE invoices SET statut = 'retard'
      WHERE statut = 'envoyee' AND date_echeance < $1
    `, [today]);
    await client.query('COMMIT');
    if (result.rowCount > 0) {
      console.log(`[CRON] ${result.rowCount} facture(s) marquée(s) "en retard"`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[CRON updateOverdue]', err.message);
  } finally {
    client.release();
  }
}

// ─── INIT DB: create tables + seed if empty ──────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      prenom          TEXT    NOT NULL DEFAULT '',
      nom             TEXT    NOT NULL DEFAULT '',
      email           TEXT    NOT NULL UNIQUE,
      password_hash   TEXT    NOT NULL,
      entreprise      TEXT    NOT NULL DEFAULT '',
      siren           TEXT    DEFAULT '',
      tva_num         TEXT    DEFAULT '',
      adresse         TEXT    DEFAULT '',
      tel             TEXT    DEFAULT '',
      iban            TEXT    DEFAULT '',
      bic             TEXT    DEFAULT '',
      plan            TEXT    DEFAULT 'essentiel',
      couleur_facture TEXT    DEFAULT '#1B3A4B',
      logo            TEXT    DEFAULT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      nom             TEXT    NOT NULL,
      siret           TEXT    DEFAULT '',
      email           TEXT    DEFAULT '',
      tel             TEXT    DEFAULT '',
      adresse         TEXT    DEFAULT '',
      secteur         TEXT    DEFAULT '',
      delai_paiement  INTEGER DEFAULT 30,
      risque          TEXT    DEFAULT 'faible',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      client_id       INTEGER,
      client_nom      TEXT    NOT NULL DEFAULT '',
      numero          TEXT    NOT NULL,
      objet           TEXT    DEFAULT '',
      montant_ht      NUMERIC(12,2) NOT NULL DEFAULT 0,
      tva             NUMERIC(5,2)  NOT NULL DEFAULT 20,
      montant_ttc     NUMERIC(12,2) NOT NULL DEFAULT 0,
      date_emission   TEXT    NOT NULL,
      date_echeance   TEXT    NOT NULL,
      statut          TEXT    NOT NULL DEFAULT 'brouillon',
      facture_x       INTEGER NOT NULL DEFAULT 1,
      notes           TEXT    DEFAULT '',
      lignes          TEXT    DEFAULT '',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS relances (
      id          SERIAL PRIMARY KEY,
      invoice_id  INTEGER NOT NULL,
      type        TEXT    DEFAULT 'email',
      ton         TEXT    DEFAULT 'cordial',
      message     TEXT    DEFAULT '',
      statut      TEXT    DEFAULT 'envoyée',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id    TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_views (
      id          SERIAL PRIMARY KEY,
      invoice_id  INTEGER NOT NULL,
      viewed_at   TIMESTAMPTZ DEFAULT NOW(),
      ip          TEXT DEFAULT ''
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_clients_user  ON clients(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_relances_inv  ON relances(invoice_id)');

  // ── Gestionnaire de migrations versionné ─────────────────────────────────
  // Exécute uniquement les migrations manquantes → cold start < 500ms après la v1
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const { rows: [vRow] } = await pool.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version');
  const currentVersion = parseInt(vRow.v, 10);

  // ── Migration 001 : snapshot + NUMERIC + audit + password_resets ──────────
  if (currentVersion < 1) {
    await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_snapshot JSONB DEFAULT NULL`).catch(() => {});
    await pool.query(`
      ALTER TABLE invoices
        ALTER COLUMN montant_ht  TYPE NUMERIC(12,2) USING montant_ht::NUMERIC(12,2),
        ALTER COLUMN tva         TYPE NUMERIC(5,2)  USING tva::NUMERIC(5,2),
        ALTER COLUMN montant_ttc TYPE NUMERIC(12,2) USING montant_ttc::NUMERIC(12,2)
    `).catch(() => {});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        action      TEXT    NOT NULL,
        entity      TEXT    NOT NULL,
        entity_id   INTEGER,
        payload     JSONB,
        ip          TEXT    DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC)').catch(() => {});
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_numero ON invoices(user_id, numero)').catch(() => {});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         SERIAL PRIMARY KEY,
        email      TEXT NOT NULL,
        code       TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pwd_reset_email ON password_resets(email, expires_at DESC)').catch(() => {});
    await pool.query(`
      CREATE OR REPLACE FUNCTION cleanup_expired_resets() RETURNS void AS $$
      BEGIN DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL '1 hour'; END;
      $$ LANGUAGE plpgsql
    `).catch(() => {});
    await pool.query(`INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING`);
    console.log('[DB] Migration 001 appliquée');
  }

  // ── Migration 002 : stripe_customer column ────────────────────────────────
  if (currentVersion < 2) {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer TEXT DEFAULT NULL`).catch(() => {});
    await pool.query(`INSERT INTO schema_version (version) VALUES (2) ON CONFLICT DO NOTHING`);
    console.log('[DB] Migration 002 appliquée');
  }

  // ── Migration 003 : cycle de vie PDP (réforme 2026) ──────────────────────
  if (currentVersion < 3) {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pdp_status') THEN
          CREATE TYPE pdp_status AS ENUM ('deposee','rejetee','refusee','approuvee','encaissee');
        END IF;
      END;
      $$
    `).catch(() => {});
    await pool.query(`
      ALTER TABLE invoices
        ADD COLUMN IF NOT EXISTS pdp_status  pdp_status  DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS pdp_sent_at TIMESTAMPTZ DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS pdp_ref     TEXT        DEFAULT NULL
    `).catch(() => {});
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_invoices_pdp_status
        ON invoices(user_id, pdp_status) WHERE pdp_status IS NOT NULL
    `).catch(() => {});
    await pool.query(`INSERT INTO schema_version (version) VALUES (3) ON CONFLICT DO NOTHING`);
    console.log('[DB] Migration 003 appliquée (PDP statuses)');
  }

  // ── Migration 004 : Row Level Security — défense en profondeur ───────────
  // Objectif : même si le code JS oublie un WHERE user_id=$1, la DB refuse
  // Mécanisme : SET LOCAL app.current_user_id avant chaque requête sensible
  //             → via pool.queryAsUser(userId, sql, params)
  // Note : FORCE RLS est activé → s'applique même au rôle postgres (superuser)
  //        Les migrations/seed bypass via app.bypass_rls='on' (session interne)
  if (currentVersion < 4) {
    // ── Activer RLS + FORCE sur les 3 tables sensibles ──────────────────────
    for (const t of ['clients', 'invoices', 'relances']) {
      await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).catch(() => {});
      await pool.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`).catch(() => {});
      // Supprimer les policies existantes pour éviter les doublons
      await pool.query(`DROP POLICY IF EXISTS owner_access  ON ${t}`).catch(() => {});
      await pool.query(`DROP POLICY IF EXISTS bypass_mig    ON ${t}`).catch(() => {});
    }

    // ── Policy owner : accès uniquement à ses propres lignes ─────────────────
    await pool.query(`
      CREATE POLICY owner_access ON clients
        USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer)
    `).catch(() => {});

    await pool.query(`
      CREATE POLICY owner_access ON invoices
        USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer)
    `).catch(() => {});

    // relances n'a pas de user_id direct — on remonte via invoices
    await pool.query(`
      CREATE POLICY owner_access ON relances
        USING (
          EXISTS (
            SELECT 1 FROM invoices i
            WHERE  i.id = relances.invoice_id
            AND    i.user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer
          )
        )
    `).catch(() => {});

    // ── Policy bypass : migrations / seed / cron (SET app.bypass_rls='on') ──
    for (const t of ['clients', 'invoices', 'relances']) {
      await pool.query(`
        CREATE POLICY bypass_mig ON ${t}
          USING (current_setting('app.bypass_rls', true) = 'on')
      `).catch(() => {});
    }

    await pool.query(`INSERT INTO schema_version (version) VALUES (4) ON CONFLICT DO NOTHING`);
    console.log('[DB] Migration 004 appliquée (RLS owner_access + bypass_mig)');
  }

  // Seed si la table users est vide
  const { rows } = await pool.query('SELECT COUNT(*) as n FROM users');
  if (parseInt(rows[0].n, 10) === 0) {
    await seedDemo();
  }

  // Mise à jour des statuts au démarrage
  await updateOverdueStatuses();

  // Sur Vercel (serverless), setInterval ne tourne pas entre les invocations
  if (!process.env.VERCEL) {
    setInterval(updateOverdueStatuses, 60 * 60 * 1000);
  }

  console.log('✅  PostgreSQL connecté et prêt');
}

// Lance l'init — tous les erreurs sont loguées et propagées via la promise
// Le middleware server.js retourne 503 si ready rejette (pas de process.exit)
const ready = initDB().catch(err => {
  console.error('[DB] Erreur d\'initialisation :', err.message);
  throw err;
});

// ─── queryAsUser : exécute une requête dans le contexte RLS d'un utilisateur ──
// Ouvre une transaction, SET LOCAL app.current_user_id = userId, exécute, COMMIT.
// pgbouncer transaction pooler : SET LOCAL tenu sur toute la transaction ✓
pool.queryAsUser = async function queryAsUser(userId, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_user_id', $1::text, true)",
      [String(userId)]
    );
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ─── bypassRLS : exécute une requête admin sans restriction RLS ──────────────
// Utilisé par seedDemo(), updateOverdueStatuses(), initDB()
// NE PAS exposer aux routes user-facing
pool.bypassRLS = async function bypassRLS(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

module.exports = pool;
module.exports.ready = ready;
