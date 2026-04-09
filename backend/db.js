'use strict';
// Use Node.js v22.5+ built-in SQLite (no native compilation needed)
const { DatabaseSync } = require('node:sqlite');
const path   = require('path');
const bcrypt = require('bcryptjs');

// Suppress the "experimental" warning from node:sqlite
const _emit = process.emit.bind(process);
process.emit = (event, ...args) => {
  if (event === 'warning' && args[0]?.name === 'ExperimentalWarning' &&
      String(args[0]?.message).includes('SQLite')) return false;
  return _emit(event, ...args);
};

const DB_PATH = path.join(__dirname, 'facturepilot.db');
const db = new DatabaseSync(DB_PATH);

// ─── WAL mode + foreign keys ─────────────────────────────────────────────────
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    nom             TEXT    NOT NULL,
    siret           TEXT    DEFAULT '',
    email           TEXT    DEFAULT '',
    tel             TEXT    DEFAULT '',
    adresse         TEXT    DEFAULT '',
    secteur         TEXT    DEFAULT '',
    delai_paiement  INTEGER DEFAULT 30,
    risque          TEXT    DEFAULT 'faible',
    created_at      TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    client_id       INTEGER,
    client_nom      TEXT    NOT NULL DEFAULT '',
    numero          TEXT    NOT NULL,
    objet           TEXT    DEFAULT '',
    montant_ht      REAL    NOT NULL DEFAULT 0,
    tva             REAL    NOT NULL DEFAULT 20,
    montant_ttc     REAL    NOT NULL DEFAULT 0,
    date_emission   TEXT    NOT NULL,
    date_echeance   TEXT    NOT NULL,
    statut          TEXT    NOT NULL DEFAULT 'brouillon',
    facture_x       INTEGER NOT NULL DEFAULT 1,
    notes           TEXT    DEFAULT '',
    lignes          TEXT    DEFAULT '',
    created_at      TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS relances (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id  INTEGER NOT NULL,
    type        TEXT    DEFAULT 'email',
    ton         TEXT    DEFAULT 'cordial',
    message     TEXT    DEFAULT '',
    statut      TEXT    DEFAULT 'envoyée',
    created_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_clients_user  ON clients(user_id);
`);

// ─── MIGRATION: add lignes column if missing (safe for existing DBs) ──────────
try {
  db.exec(`ALTER TABLE invoices ADD COLUMN lignes TEXT DEFAULT ''`);
} catch(_) { /* column already exists — ignore */ }

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
  CREATE INDEX IF NOT EXISTS idx_relances_inv  ON relances(invoice_id);
`);

// ─── HELPER: date offset ──────────────────────────────────────────────────────
const d = (offset = 0) => {
  const dt = new Date();
  dt.setDate(dt.getDate() + offset);
  return dt.toISOString().split('T')[0];
};

// ─── SEED: create demo user + data if DB is empty ────────────────────────────
const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
if (count === 0) {
  db.exec('BEGIN');
  try {
    const hash = bcrypt.hashSync('demo1234', 10);
    const { lastInsertRowid: uid } = db.prepare(`
      INSERT INTO users (prenom,nom,email,password_hash,entreprise,siren,tva_num,adresse,tel,iban,plan,couleur_facture)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run('Hamza','Hadjadj','hamza@facturepilot.ai',hash,
           'FacturePilot AI','123456789','FR12123456789',
           '12 rue de la Libération, 52100 Saint-Dizier',
           '06 00 00 00 00','FR76 3000 6000 0112 3456 7890 189','pro','#1B3A4B');

    const insC = db.prepare(
      'INSERT INTO clients (user_id,nom,siret,email,tel,adresse,secteur,delai_paiement,risque,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    const cids = [
      [uid,'Agence Dupont','41234567800010','contact@agence-dupont.fr','03 25 12 34 56','12 rue de la Paix, 51100 Reims','Communication',30,'faible',d(-80)],
      [uid,'BTP Martin SARL','55678901200034','facturation@btpmartin.fr','03 25 87 65 43','8 avenue Gambetta, 52100 Saint-Dizier','BTP',45,'moyen',d(-70)],
      [uid,'Pharma Loire','78901234500056','compta@pharmaloire.fr','02 41 23 45 67','45 rue Nationale, 49000 Angers','Pharmacie',30,'faible',d(-60)],
      [uid,'Coiffure Élise','89012345600078','elise.dupuis@gmail.com','06 12 34 56 78','3 place de la Mairie, 52100 Saint-Dizier','Services',15,'élevé',d(-50)],
      [uid,'Cabinet RH Morin','12345678900090','morin@cabinetmorin.fr','03 25 45 67 89','18 rue Gambetta, 54000 Nancy','Conseil RH',30,'faible',d(-45)],
      [uid,'Auto-école Dupuis','23456789000012','auto-ecole@dupuis52.fr','03 25 31 22 11','7 rue du Général de Gaulle, 52100 Saint-Dizier','Formation',30,'moyen',d(-40)],
    ].map(row => insC.run(...row).lastInsertRowid);

    const insI = db.prepare(
      'INSERT INTO invoices (user_id,client_id,client_nom,numero,objet,montant_ht,tva,montant_ttc,date_emission,date_echeance,statut,facture_x) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)'
    );
    const invData = [
      [uid,cids[0],'Agence Dupont','FA-2026-001','Développement site web — T1 2026',2666.67,20,3200,d(-60),d(-30),'payee'],
      [uid,cids[5],'Auto-école Dupuis','FA-2026-002','Audit de conformité numérique',816.67,20,980,d(-45),d(-15),'brouillon'],
      [uid,cids[4],'Cabinet RH Morin','FA-2026-003','Formation gestion administrative',625,20,750,d(-7),d(23),'envoyee'],
      [uid,cids[2],'Pharma Loire','FA-2026-004','Intégration logiciel ERP — Phase 1',4500,20,5400,d(-3),d(27),'envoyee'],
      [uid,cids[3],'Coiffure Élise','FA-2026-005','Création site vitrine + référencement',208.33,20,250,d(-30),d(-8),'retard'],
      [uid,cids[1],'BTP Martin SARL','FA-2026-006','Conseil en gestion de flux — Q1 2026',1541.67,20,1850,d(-45),d(-14),'retard'],
      [uid,cids[0],'Agence Dupont','FA-2026-007','Maintenance mensuelle — Avril 2026',2666.67,20,3200,d(-1),d(29),'envoyee'],
    ];
    const iids = invData.map(row => insI.run(...row).lastInsertRowid);

    // Relances for overdue invoices
    const insR = db.prepare('INSERT INTO relances (invoice_id,type,ton,statut,created_at) VALUES (?,?,?,?,?)');
    insR.run(iids[4],'email','cordial','envoyée',d(-3));
    insR.run(iids[5],'email','cordial','envoyée',d(-7));
    insR.run(iids[5],'sms','ferme','envoyée',d(-2));

    db.exec('COMMIT');
    console.log('✅  Base de données initialisée avec les données de démo');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ─── Cron : mise à jour automatique des statuts "retard" ─────────────────────
// Marque "retard" toute facture "envoyee" dont l'échéance est dépassée
function updateOverdueStatuses() {
  const today = new Date().toISOString().split('T')[0];
  const result = db.prepare(`
    UPDATE invoices SET statut = 'retard'
    WHERE statut = 'envoyee' AND date_echeance < ?
  `).run(today);
  if (result.changes > 0) {
    console.log(`[CRON] ${result.changes} facture(s) marquée(s) "en retard"`);
  }
}

// Lancer immédiatement au démarrage puis toutes les heures
updateOverdueStatuses();
setInterval(updateOverdueStatuses, 60 * 60 * 1000);

module.exports = db;
