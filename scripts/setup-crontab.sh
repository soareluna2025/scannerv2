#!/bin/bash
# ============================================================================
#  setup-crontab.sh — instalează COMPLET crontab-ul AlohaScan (idempotent).
#
#  • Citește CRON_SECRET din /root/scannerv2/.env și îl injectează în headerul
#    `x-cron-secret` al FIECĂRUI apel /api/cron/* (guard din server.js).
#  • REPLACE total al crontab-ului utilizatorului (echo | crontab -) → lista de
#    mai jos devine CANONICĂ. Orice cron care NU e aici va fi ȘTERS din crontab.
#  • Secretul NU e în repo: e citit din .env LA RULARE. (Apare însă în
#    `crontab -l` pe VPS — acceptabil pe un VPS root privat.)
#
#  Rulează O SINGURĂ DATĂ pe VPS, după deploy SAU după ce adaugi un cron nou aici:
#     bash scripts/setup-crontab.sh
# ============================================================================

set -e
APP_DIR="/root/scannerv2"

# 1. Citește secretul din .env (KEY=VALUE). Fail-fast dacă lipsește → NU scriem
#    un crontab fără auth (ar lăsa endpoint-urile expuse / ar primi 401).
set -a
. "${APP_DIR}/.env"
set +a
if [ -z "${CRON_SECRET}" ]; then
  echo "EROARE: CRON_SECRET lipsește din ${APP_DIR}/.env — abort." >&2
  exit 1
fi

mkdir -p "${APP_DIR}/logs"
HDR="x-cron-secret: ${CRON_SECRET}"
BASE="http://localhost:3000"
LOG="${APP_DIR}/logs/cron.log"

# 2. Construiește crontab-ul complet. Fiecare apel /api/cron/* trimite headerul.
#    learning-analysis = POST; collect-venues/coaches = --max-time 120;
#    train_model.py = Python (sursează .env la run pt conexiunea DB).
NEW_CRONTAB=$(cat <<EOF
# ── AlohaScan crontab — GENERAT de scripts/setup-crontab.sh (nu edita manual) ──
*/5 * * * * curl -sf -H "${HDR}" ${BASE}/api/cron/prematch-enrichment >> ${LOG} 2>&1
*/5 * * * * curl -sf -H "${HDR}" ${BASE}/api/cron/cazarma-router >> ${LOG} 2>&1
30 0 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/auto-predict >> ${LOG} 2>&1
0 3 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/build-ml-features >> ${LOG} 2>&1
0 2 * * * curl -sf -H "${HDR}" ${BASE}/api/update-results >> ${LOG} 2>&1
5 2 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/collect-squads >> ${LOG} 2>&1
0 23 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/collect-finished >> ${LOG} 2>&1
0 6 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/collect-daily >> ${LOG} 2>&1
0 1 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/collect-top-scorers >> ${LOG} 2>&1
30 1 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/collect-players-season >> ${LOG} 2>&1
0 4 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/league-stats >> ${LOG} 2>&1
0 4 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/coach-stats >> ${LOG} 2>&1
30 4 * * * curl -sf -H "${HDR}" ${BASE}/api/cron/referee-stats >> ${LOG} 2>&1
30 3 * * * curl -sf --max-time 120 -H "${HDR}" ${BASE}/api/cron/collect-venues >> ${LOG} 2>&1
45 3 * * * curl -sf --max-time 120 -H "${HDR}" ${BASE}/api/cron/collect-coaches >> ${LOG} 2>&1
30 3 * * * curl -sf -X POST -H "${HDR}" ${BASE}/api/cron/learning-analysis >> ${LOG} 2>&1
0 5 * * 0 curl -sf -H "${HDR}" ${BASE}/api/cron/recalibrate-tables >> ${LOG} 2>&1
30 5 * * 0 curl -sf -H "${HDR}" ${BASE}/api/cron/calibrate-live >> ${LOG} 2>&1
0 6 * * 1 curl -sf -H "${HDR}" ${BASE}/api/cron/build-elo >> ${LOG} 2>&1
0 3 * * 1 curl -sf -H "${HDR}" ${BASE}/api/cron/collect-national-history >> ${LOG} 2>&1
0 3 1 * * curl -sf -H "${HDR}" ${BASE}/api/cron/cleanup-settings >> ${APP_DIR}/ml/cleanup.log 2>&1
15 4 * * * /root/scripts/backup-db.sh >> /var/log/alohascan-backup.log 2>&1
30 5 * * * cd ${APP_DIR} && set -a && . ${APP_DIR}/.env && set +a && python3 ml/train_model.py >> ${APP_DIR}/ml/train.log 2>&1
30 6 * * * cd /root/scannerv2 && python3 -u ml/train_live_v2.py >> /root/.pm2/logs/train-live-v2.log 2>&1
EOF
)

# 3. Aplică (REPLACE total).
echo "$NEW_CRONTAB" | crontab -

# 4. Verifică.
echo "Crontab AlohaScan instalat. Total linii: $(crontab -l | wc -l)"
echo "Linii active (fără comentarii/goale): $(crontab -l | grep -vcE '^\s*#|^\s*$')"
echo "--- crontab -l ---"
crontab -l
