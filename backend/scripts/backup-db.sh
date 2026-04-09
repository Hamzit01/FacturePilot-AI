#!/bin/bash
# ─── Backup SQLite — FacturePilot AI ─────────────────────────────────────────
# Usage: bash scripts/backup-db.sh
# Cron : 0 2 * * * /path/to/backend/scripts/backup-db.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_FILE="$SCRIPT_DIR/../facturepilot.db"
BACKUP_DIR="$SCRIPT_DIR/../backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/facturepilot_$DATE.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
  echo "❌ Base de données introuvable : $DB_FILE"
  exit 1
fi

# Utilise SQLite online backup (safe even with active connections)
sqlite3 "$DB_FILE" ".backup $BACKUP_FILE"
echo "✅ Backup créé : $BACKUP_FILE"

# Conserver seulement les 30 derniers backups
ls -t "$BACKUP_DIR"/*.db 2>/dev/null | tail -n +31 | xargs -r rm --
echo "🗂  Anciens backups nettoyés (>30)"
