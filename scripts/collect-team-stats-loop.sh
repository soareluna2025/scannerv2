#!/bin/bash
# Loop collect-team-stats pana cand nu mai sunt perechi de actualizat
# Usage: bash scripts/collect-team-stats-loop.sh [limit_per_run] [season]
LIMIT=${1:-40}
SEASON=${2:-2025}
DELAY=3  # secunde intre runde (API rate limit: 100 req/min)
TOTAL=0
RUN=0

echo "[$(date '+%H:%M:%S')] START collect-team-stats loop | limit=$LIMIT season=$SEASON"

while true; do
  RUN=$((RUN + 1))
  RESULT=$(curl -s "http://localhost:3001/api/cron/collect-team-stats?limit=$LIMIT&season=$SEASON")

  OK=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(String(r.ok))}catch(e){process.stdout.write('false')}})")
  PAIRS=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(String(r.pairs_found||0))}catch(e){process.stdout.write('0')}})")
  UPSERTED=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(String(r.upserted||0))}catch(e){process.stdout.write('0')}})")
  DB_TOTAL=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(String(r.total_in_db||0))}catch(e){process.stdout.write('0')}})")
  ERROR=$(echo "$RESULT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write(r.error||'')}catch(e){process.stdout.write(e.message)}})")

  TOTAL=$((TOTAL + UPSERTED))
  echo "[$(date '+%H:%M:%S')] Run #$RUN | pairs=$PAIRS upserted=$UPSERTED total_db=$DB_TOTAL cumul=$TOTAL"

  if [ "$OK" != "true" ]; then
    echo "[$(date '+%H:%M:%S')] EROARE: $ERROR"
    echo "[$(date '+%H:%M:%S')] Oprire loop."
    break
  fi

  if [ "$PAIRS" -eq 0 ] 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] DONE — nu mai sunt perechi de actualizat. Total upserted: $TOTAL"
    break
  fi

  sleep $DELAY
done
