#!/usr/bin/env bash
# auto-deploy.sh — DEPLOY PULL-BASED, rulat din cron pe VPS (la 3 minute).
# De ce: GitHub Actions → SSH cu parolă a picat (15.11, "unable to authenticate") și blochează orice deploy.
# Aici VPS-ul ÎNSUȘI verifică GitHub (repo public, fără parolă/secret) și se actualizează când main s-a schimbat.
#
# Ce face: dacă origin/main != HEAD local → backup artefacte ML, git reset --hard origin/main, restore,
# npm install, instalare backup-db.sh, setup-crontab.sh, pm2 restart + health check.
# Dacă health pică după deploy → revine automat la commit-ul anterior și nu mai reîncearcă acel commit.
# NU scrie .env (se schimbă doar la rotirea secretelor — vezi deploy.yml / recover.sh).
#
# Cron (instalat de scripts/setup-crontab.sh):
#   */3 * * * * flock -n /tmp/auto-deploy.lock bash /root/scannerv2/scripts/auto-deploy.sh >> /root/scannerv2/logs/auto-deploy.log 2>&1
set -u

# Rulează dintr-o COPIE în /tmp: git reset --hard înlocuiește acest fișier în timpul execuției.
if [ "${1:-}" != "--from-tmp" ]; then
  cp "$0" /tmp/auto-deploy.run.sh && exec bash /tmp/auto-deploy.run.sh --from-tmp
fi

APP=/root/scannerv2
FAILED_FILE=/root/.auto-deploy-failed-sha
PM2_BIN=$(cat /root/.pm2_bin 2>/dev/null || true)
[ -n "$PM2_BIN" ] || PM2_BIN=pm2
export PATH="/snap/bin:/usr/local/bin:/usr/bin:/bin:$(dirname "$PM2_BIN"):$PATH"
ts() { date '+%F %T'; }

cd "$APP" || { echo "[$(ts)] EROARE: $APP nu există"; exit 1; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)
[ -n "$REMOTE" ] || { echo "[$(ts)] git ls-remote a eșuat (rețea?) — sar peste"; exit 0; }
[ "$LOCAL" = "$REMOTE" ] && exit 0
if [ "$(cat "$FAILED_FILE" 2>/dev/null)" = "$REMOTE" ]; then
  exit 0   # acest commit a picat deja health-ul; aștept un commit nou
fi

ML_FILES="model_live_export.json model_export.json calibration_export.json calibration_live_export.json gg_calibration.json"
backup_ml()  { for f in $ML_FILES; do cp "ml/$f" "/tmp/$f.bak" 2>/dev/null || true; done; }
restore_ml() { for f in $ML_FILES; do cp "/tmp/$f.bak" "ml/$f" 2>/dev/null || true; done; }
healthy() {
  for _ in $(seq 1 15); do
    curl -sf -m 4 http://localhost:3000/health >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
apply_code() {   # $1 = commit țintă
  bash scripts/pre-deploy-backup.sh 2>/dev/null || true   # salvează modificările locale de pe VPS (nu le șterge fără urmă)
  backup_ml
  git fetch -q origin || return 1
  git reset -q --hard "$1" || return 1
  restore_ml
  npm install --silent || echo "[$(ts)] ATENȚIE: npm install a dat eroare"
  mkdir -p /root/scripts && cp scripts/backup-db.sh /root/scripts/backup-db.sh 2>/dev/null && chmod +x /root/scripts/backup-db.sh
  bash scripts/setup-crontab.sh >/dev/null 2>&1 || echo "[$(ts)] ATENȚIE: setup-crontab.sh a eșuat (CRON_SECRET lipsă în .env?)"
  "$PM2_BIN" restart alohascan >/dev/null 2>&1 || "$PM2_BIN" start ecosystem.config.cjs >/dev/null 2>&1
  "$PM2_BIN" save >/dev/null 2>&1 || true
}

echo "[$(ts)] DEPLOY ${LOCAL:0:7} -> ${REMOTE:0:7}"
apply_code "$REMOTE"
if healthy; then
  rm -f "$FAILED_FILE"
  echo "[$(ts)] OK: $(git rev-parse --short HEAD) online"
else
  echo "[$(ts)] HEALTH PICAT pe ${REMOTE:0:7} — revin la ${LOCAL:0:7}"
  echo "$REMOTE" > "$FAILED_FILE"
  apply_code "$LOCAL"
  healthy && echo "[$(ts)] Rollback OK: ${LOCAL:0:7} online" || echo "[$(ts)] ROLLBACK ȘI HEALTH PICATE — verifică: pm2 logs alohascan --lines 50"
fi
