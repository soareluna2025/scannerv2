#!/bin/bash
# scripts/backup-db.sh — Backup automat PostgreSQL → GitHub
# Rulează zilnic la 03:30 via crontab pe VPS
#
# CREDENȚIALE — NU hardcodate:
#   parola DB  → extrasă din POSTGRES_URL în /root/scannerv2/.env
#   token GitHub → citit din /root/.github_backup_token (scris la deploy)

set -e

DATE=$(date +%Y-%m-%d)
BACKUP_DIR="/root/backups/$DATE"
REPO_DIR="/root/scannerv2-backups"
DB_NAME="elefant"
DB_USER="alohascan"
TS="[Backup $(date '+%H:%M:%S')]"

echo "$TS Start: $DATE"
mkdir -p "$BACKUP_DIR"

# ── Extrage parola DB din POSTGRES_URL (.env) ─────────────────────────────────
# shellcheck source=/dev/null
source /root/scannerv2/.env 2>/dev/null || true
DB_PASS=$(echo "${POSTGRES_URL:-}" | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|')
if [ -z "$DB_PASS" ]; then
  echo "$TS ERROR: Nu s-a putut extrage parola din POSTGRES_URL — verifică /root/scannerv2/.env"
  exit 1
fi

# ── Token GitHub pentru push ──────────────────────────────────────────────────
GITHUB_TOKEN=$(cat /root/.github_backup_token 2>/dev/null || echo "")
if [ -z "$GITHUB_TOKEN" ]; then
  echo "$TS ERROR: /root/.github_backup_token lipseste"
  echo "$TS Rulează deploy din GitHub Actions pentru a seta tokenul."
  exit 1
fi

# ── Tabele de backup ──────────────────────────────────────────────────────────
TABLES=(
  "fixtures_history"
  "player_stats"
  "predictions"
  "fixtures"
  "standings"
  "h2h"
  "form_stats"
  "league_stats"
  "referee_stats"
  "match_stats"
  "match_events"
  "odds"
  "teams"
  "leagues"
  "alerts"
  "backfill_progress"
  "app_settings"
  "model_weights"
  "prediction_log"
)

# ── Dump tabele individuale (gzip — max ~100MB/fișier pentru GitHub) ──────────
for TABLE in "${TABLES[@]}"; do
  echo "$TS Dumping $TABLE..."
  PGPASSWORD="$DB_PASS" pg_dump \
    -U "$DB_USER" -h 127.0.0.1 -d "$DB_NAME" \
    -t "$TABLE" --no-owner --no-acl -F p \
    2>/dev/null \
    | gzip > "$BACKUP_DIR/${TABLE}.sql.gz" \
    || echo "$TS WARN: $TABLE nu există sau e goală — skip"

  SIZE=$(du -sh "$BACKUP_DIR/${TABLE}.sql.gz" 2>/dev/null | cut -f1 || echo "0")
  echo "$TS   $TABLE: $SIZE"
done

# ── Schema completă (fără date) ───────────────────────────────────────────────
echo "$TS Dumping schema..."
PGPASSWORD="$DB_PASS" pg_dump \
  -U "$DB_USER" -h 127.0.0.1 -d "$DB_NAME" \
  --schema-only --no-owner \
  | gzip > "$BACKUP_DIR/schema.sql.gz"

echo "$TS Toate tabelele dumped."

# ── Verificare fișiere > 100MB (limita GitHub) ────────────────────────────────
BIG_FILES=$(find "$BACKUP_DIR" -name "*.gz" -size +95M 2>/dev/null)
if [ -n "$BIG_FILES" ]; then
  echo "$TS WARN: Fișiere mai mari de 95MB (aproape de limita GitHub 100MB):"
  echo "$BIG_FILES" | while read -r f; do echo "  $(du -sh "$f")"; done
fi

# ── Setup repo local ──────────────────────────────────────────────────────────
REPO_URL="https://${GITHUB_TOKEN}@github.com/soareluna2025/scannerv2-backups.git"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "$TS Clonare scannerv2-backups..."
  git clone "$REPO_URL" "$REPO_DIR" 2>/dev/null || {
    mkdir -p "$REPO_DIR"
    cd "$REPO_DIR"
    git init
    git remote add origin "$REPO_URL"
    git fetch origin main 2>/dev/null || true
    git checkout main 2>/dev/null || git checkout -b main
  }
else
  cd "$REPO_DIR"
  git remote set-url origin "$REPO_URL"
  git pull origin main 2>/dev/null || true
fi

# ── Copiază backup-urile noi ──────────────────────────────────────────────────
mkdir -p "$REPO_DIR/$DATE"
cp "$BACKUP_DIR/"*.gz "$REPO_DIR/$DATE/"

# ── Șterge backup-uri mai vechi de 7 zile din repo ───────────────────────────
find "$REPO_DIR" -maxdepth 1 -type d -name "20*" | sort | head -n -7 | xargs rm -rf 2>/dev/null || true

# ── Actualizează README ───────────────────────────────────────────────────────
cat > "$REPO_DIR/README.md" << README
# AlohaScan DB Backups

Ultima actualizare: $DATE
Tabele backed up: ${#TABLES[@]}
Retenție: ultimele 7 zile (local + GitHub)

## Restaurare
\`\`\`bash
gunzip -c $DATE/fixtures_history.sql.gz | psql -U alohascan -d elefant
\`\`\`
README

# ── Commit și push ────────────────────────────────────────────────────────────
cd "$REPO_DIR"
git config user.email "backup@alohascan.com"
git config user.name "AlohaScan Backup"
git add -A

if git diff --cached --quiet; then
  echo "$TS Nimic nou de commitat."
else
  git commit -m "backup: $DATE (${#TABLES[@]} tabele)"
  git push origin main 2>/dev/null \
    && echo "$TS Push pe GitHub complet!" \
    || echo "$TS WARN: Push esuat — verifică tokenul în /root/.github_backup_token"
fi

# ── Curăță backup-uri locale mai vechi de 7 zile ─────────────────────────────
find /root/backups -maxdepth 1 -type d -name "20*" | sort | head -n -7 | xargs rm -rf 2>/dev/null || true

echo "$TS Gata! Backup $DATE finalizat."
