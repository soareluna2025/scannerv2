#!/bin/bash
# Adaugă în crontab antrenarea ML zilnică la 05:30. Idempotent (înlocuiește linia veche).
#
# SECURITATE: NU hardcodăm parola DB. Cron-ul sursează /root/scannerv2/.env
# (care conține POSTGRES_URL / PG* pe VPS, gitignored), iar ml/train_model.py
# citește conexiunea din mediu. (`export PGPASSWORD=${PGPASSWORD}` ar fi GOL la
# rulare cron — cron-ul nu moștenește mediul shell-ului — deci nu funcționează.)
#
# Rulează O SINGURĂ DATĂ pe VPS, după deploy:
#   bash scripts/setup-crontab.sh

set -e
APP_DIR="/root/scannerv2"

CRON_CMD="30 5 * * * cd ${APP_DIR} && set -a && . ${APP_DIR}/.env && set +a && python3 ml/train_model.py >> ${APP_DIR}/ml/train.log 2>&1"

# Înlocuiește orice linie veche care rulează train_model.py, apoi adaugă cea nouă.
( crontab -l 2>/dev/null | grep -v 'ml/train_model.py'; echo "$CRON_CMD" ) | crontab -

echo "Crontab ML setat (antrenare zilnică 05:30):"
crontab -l | grep 'ml/train_model.py'

# Curățare lunară app_settings — prima zi a lunii la 03:00 (markeri bloat).
# Sursează .env la RUN time → header x-cron-secret cu valoarea reală (secretul NU
# se scrie în crontab; ${CRON_SECRET} e expandat de shell-ul cron-ului, nu aici).
CLEANUP_CMD="0 3 1 * * set -a && . ${APP_DIR}/.env && set +a && curl -sf -H \"x-cron-secret: \${CRON_SECRET}\" http://localhost:3000/api/cron/cleanup-settings >> ${APP_DIR}/ml/cleanup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'api/cron/cleanup-settings'; echo "$CLEANUP_CMD" ) | crontab -

echo "Crontab cleanup-settings setat (lunar, ziua 1 la 03:00):"
crontab -l | grep 'api/cron/cleanup-settings'

# ⚠ TOATE celelalte linii curl /api/cron/* din crontab (collect-daily, scan,
# build-elo, backfill-*, etc. — setate MANUAL pe VPS, NU în acest repo) TREBUIE
# actualizate să trimită ACELAȘI header, altfel vor primi 401 după deploy:
#   set -a && . ${APP_DIR}/.env && set +a && \
#     curl -sf -H "x-cron-secret: \${CRON_SECRET}" http://localhost:3000/api/cron/<nume>
