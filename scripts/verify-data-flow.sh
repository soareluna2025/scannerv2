#!/bin/bash
# ============================================================================
#  verify-data-flow.sh — „card de completitudine" per meci (read-only).
#  Arată, pentru un fixture_id (sau un FT recent ales automat), ce date avem în
#  fiecare tabel relevant + verdict ✅/⚠️/❌ + scor de completitudine.
#  Credențiale din .env. Rulare:  bash scripts/verify-data-flow.sh [fixture_id]
# ============================================================================
APP_DIR="/root/scannerv2"
set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi
Q(){ psql "${PGURL}" -X -v ON_ERROR_STOP=0 -P pager=off -tAc "$1" 2>/dev/null; }

FID="$1"
if [ -z "$FID" ]; then
  # alege automat un FT recent dintr-o ligă „acoperită" (≥50 rânduri match_stats)
  FID=$(Q "
    WITH covered AS (SELECT fh.league_id FROM match_stats ms
                      JOIN fixtures_history fh ON fh.fixture_id=ms.fixture_id
                     GROUP BY fh.league_id HAVING COUNT(*)>=50)
    SELECT fixture_id FROM fixtures_history
     WHERE status_short='FT' AND home_goals IS NOT NULL
       AND league_id IN (SELECT league_id FROM covered)
     ORDER BY match_date DESC LIMIT 1")
  echo "fixture_id auto-ales (FT recent, ligă acoperită): ${FID:-<niciunul>}"
fi
if [ -z "$FID" ]; then echo "Niciun fixture disponibil — abort."; exit 1; fi

echo "════════════════════════════════════════════════════════════════"
echo "  CARD COMPLETITUDINE — fixture_id=${FID}"
echo "════════════════════════════════════════════════════════════════"
Q "SELECT '  '||home_team_name||' vs '||away_team_name||'  ('||COALESCE(home_goals::text,'?')||'-'||COALESCE(away_goals::text,'?')||')  '||COALESCE(status_short,'?')||'  '||COALESCE(match_date::date::text,'?')||'  lg='||COALESCE(league_id::text,'?') FROM fixtures_history WHERE fixture_id=${FID}"
echo ""

SCORE=0; MAX=0
chk(){ # $1=label $2=count $3=warn_extra(opțional descriere câmpuri NULL)
  MAX=$((MAX+1))
  local n="${2:-0}"; n=${n:-0}
  if [ "$n" -gt 0 ] 2>/dev/null; then
    if [ -n "$3" ]; then echo "  ⚠️  $1: $n rânduri — $3"; SCORE=$((SCORE+1));
    else echo "  ✅ $1: $n rânduri"; SCORE=$((SCORE+1)); fi
  else
    echo "  ❌ $1: lipsă"
  fi
}

# fixtures_history (+ referee NULL?)
FH=$(Q "SELECT COUNT(*) FROM fixtures_history WHERE fixture_id=${FID}")
REF=$(Q "SELECT CASE WHEN referee IS NULL OR btrim(referee)='' THEN 'referee NULL' ELSE '' END FROM fixtures_history WHERE fixture_id=${FID}")
chk "fixtures_history" "$FH" "$REF"

# match_stats (2 echipe = complet)
MS=$(Q "SELECT COUNT(*) FROM match_stats WHERE fixture_id=${FID}")
MSW=""; [ "${MS:-0}" -lt 2 ] 2>/dev/null && MSW="<2 echipe (incomplet)"
chk "match_stats" "$MS" "$MSW"

# match_events
ME=$(Q "SELECT COUNT(*) FROM match_events WHERE fixture_id=${FID}")
chk "match_events" "$ME"

# player_stats
PS=$(Q "SELECT COUNT(*) FROM player_stats WHERE fixture_id=${FID}")
PSW=""; [ "${PS:-0}" -gt 0 ] && [ "${PS:-0}" -lt 22 ] 2>/dev/null && PSW="<22 jucători"
chk "player_stats" "$PS" "$PSW"

# odds
OD=$(Q "SELECT COUNT(*) FROM odds WHERE fixture_id=${FID}")
chk "odds" "$OD"

# ml_features (1 rând + câmpuri cheie NULL?)
MF=$(Q "SELECT COUNT(*) FROM ml_features WHERE fixture_id=${FID}")
MFW=$(Q "SELECT CASE WHEN home_sot_avg IS NULL OR home_xg_avg IS NULL THEN 'câmpuri NULL (echipă fără istoric)' ELSE '' END FROM ml_features WHERE fixture_id=${FID}")
chk "ml_features" "$MF" "$MFW"

# elo_history
EH=$(Q "SELECT COUNT(*) FROM elo_history WHERE fixture_id=${FID}")
chk "elo_history" "$EH"

# fixture_positions
FP=$(Q "SELECT COUNT(*) FROM fixture_positions WHERE fixture_id=${FID}")
FPW=$(Q "SELECT CASE WHEN home_position_norm IS NULL THEN 'poziție NULL (etapă fără istoric)' ELSE '' END FROM fixture_positions WHERE fixture_id=${FID}")
chk "fixture_positions" "$FP" "$FPW"

# h2h (per pereche echipe ale meciului)
H2=$(Q "SELECT COUNT(*) FROM h2h h JOIN fixtures_history fh ON fh.fixture_id=${FID}
        WHERE (h.team1_id=LEAST(fh.home_team_id,fh.away_team_id) AND h.team2_id=GREATEST(fh.home_team_id,fh.away_team_id))")
chk "h2h (perechea)" "$H2"

echo ""
echo "────────────────────────────────────────────────────────────────"
PCT=0; [ "$MAX" -gt 0 ] && PCT=$((SCORE*100/MAX))
echo "  SCOR COMPLETITUDINE: ${SCORE}/${MAX}  (${PCT}%)"
if [ "$PCT" -ge 80 ]; then echo "  Verdict: ✅ COMPLET"; elif [ "$PCT" -ge 50 ]; then echo "  Verdict: ⚠️ PARȚIAL"; else echo "  Verdict: ❌ SĂRAC"; fi
echo "────────────────────────────────────────────────────────────────"
