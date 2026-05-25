#!/bin/bash
# =============================================================================
# ALOHASCAN — Ruleaza un cron job manual din consola
# Utilizare: bash scripts/run-cron.sh <nume-cron> [optiuni]
#
# Exemple:
#   bash scripts/run-cron.sh collect-finished
#   bash scripts/run-cron.sh collect-venues limit=50
#   bash scripts/run-cron.sh referee-extended limit=100
#   bash scripts/run-cron.sh prematch-enrichment
#   bash scripts/run-cron.sh collect-daily
# =============================================================================

APP="http://localhost:3000"

CRON_JOBS=(
  "collect-finished      — stats jucatori meciuri FT din ziua curenta"
  "collect-daily         — standings, teams, form_stats (rulare 06:00)"
  "collect-venues        — venues + geocodare lat/lng + altitudine"
  "collect-coaches       — date antrenori per echipa"
  "collect-team-stats    — statistici echipe (goals, form, CS)"
  "referee-stats         — statistici arbitri din fixtures_history"
  "referee-extended      — home_win_rate, card_bias per arbitru"
  "league-stats          — statistici agregate per liga"
  "prematch-enrichment   — date prematch in 7 etape pre-kickoff"
  "calibrate-live        — calibrare live NGP"
  "recalibrate-tables    — recalibrate tabele calibrare"
  "learning-analysis     — analiza self-learning prediction_log"
  "coach-stats           — agregat statistici coach"
  "scan                  — scanner live continuu (NU rula manual)"
)

usage() {
  echo
  echo "Utilizare: bash scripts/run-cron.sh <cron-job> [param=val ...]"
  echo
  echo "Cron jobs disponibile:"
  for j in "${CRON_JOBS[@]}"; do echo "  $j"; done
  echo
  echo "Exemple:"
  echo "  bash scripts/run-cron.sh collect-finished"
  echo "  bash scripts/run-cron.sh collect-venues limit=50"
  echo "  bash scripts/run-cron.sh referee-extended limit=200"
  echo
  exit 0
}

[ -z "$1" ] && usage

JOB="$1"
shift

# Construieste query string din argumente extra (ex: limit=50 season=2025)
QS=""
for arg in "$@"; do
  [ -z "$QS" ] && QS="?${arg}" || QS="${QS}&${arg}"
done

URL="${APP}/api/cron/${JOB}${QS}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Cron:  $JOB"
[ -n "$QS" ] && echo "  Params: ${QS:1}"
echo "  URL:   $URL"
echo "  Start: $(date '+%d.%m.%Y %H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

RESPONSE=$(curl -s --max-time 300 "$URL" 2>/dev/null)
EXIT_CODE=$?

echo "  Stop:  $(date '+%d.%m.%Y %H:%M:%S')"
echo

if [ $EXIT_CODE -ne 0 ]; then
  echo "  ❌ Curl eroare (exit $EXIT_CODE) — app pornit? (systemctl status alohascan)"
  exit 1
fi

# Afisare raspuns formatat
if command -v python3 &>/dev/null; then
  echo "$RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('  Raspuns:')
    for k, v in d.items():
        print(f'    {k}: {v}')
    if d.get('ok') == True or d.get('status') == 'success':
        print()
        print('  ✅  Job finalizat cu succes')
    elif 'error' in d:
        print()
        print(f'  ❌  Eroare: {d[\"error\"]}')
except:
    print('  Raspuns raw:', sys.stdin.read()[:500] if sys.stdin.readable() else '')
" 2>/dev/null || echo "  Raspuns: $RESPONSE"
else
  echo "  Raspuns: $RESPONSE"
fi

echo
