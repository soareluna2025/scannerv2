#!/bin/bash
# Loop referee-extended pana cand nu mai sunt arbitri de actualizat.
# Sursa date = match_events (DB/CPU, ZERO apeluri API) → limit mare e sigur.
# INITIAL-FILL (o singura data, dupa deploy):
#   cd /root/scannerv2 && bash scripts/referee-extended-loop.sh 200
# Usage: bash scripts/referee-extended-loop.sh [limit_per_run]
# NB: fără `set -e` — erorile de curl sunt tratate în buclă (check-ul OK/break de mai jos).
APP_DIR="/root/scannerv2"
# .env → CRON_SECRET (endpoint-urile /api/cron/* cer header x-cron-secret, vezi server.js).
set -a
. "${APP_DIR}/.env"
set +a
if [ -z "${CRON_SECRET}" ]; then
  echo "EROARE: CRON_SECRET lipseste din ${APP_DIR}/.env — abort." >&2
  exit 1
fi
HDR="x-cron-secret: ${CRON_SECRET}"
LIMIT=${1:-100}
TOTAL=0
RUN=0

echo "[$(date '+%H:%M:%S')] START referee-extended loop | limit=$LIMIT/run"

while true; do
  RUN=$((RUN + 1))
  RESULT=$(curl -s -H "${HDR}" "http://localhost:3000/api/cron/referee-extended?limit=$LIMIT")

  OK=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(String(r.ok))}catch(e){process.stdout.write('false')}})")
  UPDATED=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(String(r.referees_updated||0))}catch(e){process.stdout.write('0')}})")
  REMAINING=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(String(r.remaining??'?'))}catch(e){process.stdout.write('?')}})")
  ERROR=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(r.error||'')}catch(e){process.stdout.write(e.message)}})")

  TOTAL=$((TOTAL + UPDATED))
  echo "[$(date '+%H:%M:%S')] Run #$RUN | updated=$UPDATED remaining=$REMAINING cumul=$TOTAL"

  if [ "$OK" != "true" ]; then
    echo "[$(date '+%H:%M:%S')] EROARE: $ERROR"
    break
  fi

  if [ "$UPDATED" -eq 0 ] 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] DONE — toti arbitrii actualizati. Total: $TOTAL"
    break
  fi

  sleep 2
done
