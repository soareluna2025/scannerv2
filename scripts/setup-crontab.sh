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
