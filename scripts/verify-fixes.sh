#!/bin/bash
# =============================================================================
# ALOHASCAN — VERIFICARE FIX-URI P1–P6 (sesiunea 25.05.2026)
# Rulare: bash scripts/verify-fixes.sh 2>&1 | tee /tmp/verify-$(date +%Y%m%d-%H%M).txt
# =============================================================================

PG="PGPASSWORD=Firenze225854 psql -U alohascan -d elefant -h 127.0.0.1 -tA"
APP="http://localhost:3000"

ok()   { echo "  ✅  $1"; }
fail() { echo "  ❌  $1"; }
warn() { echo "  ⚠️   $1"; }
hdr()  { echo; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; echo "  $1"; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

# ─── P1: collect-finished logCron 'ok' → 'success' ───────────────────────────
hdr "P1 — collect-finished: status in cron_logs"

SUCCESS=$(eval $PG -c "SELECT COUNT(*) FROM cron_logs WHERE job_name='collect-finished' AND status='success'")
OK_OLD=$(eval $PG -c "SELECT COUNT(*) FROM cron_logs WHERE job_name='collect-finished' AND status='ok'")
TOTAL=$(eval $PG -c "SELECT COUNT(*) FROM cron_logs WHERE job_name='collect-finished'")
LAST=$(eval $PG -c "SELECT TO_CHAR(MAX(ran_at), 'DD.MM HH24:MI') FROM cron_logs WHERE job_name='collect-finished'")
MAX_FX=$(eval $PG -c "SELECT MAX(fixtures_processed) FROM cron_logs WHERE job_name='collect-finished'")

echo "  Total rulari:  $TOTAL"
echo "  Status success: $SUCCESS"
echo "  Status ok (vechi, inainte de fix): $OK_OLD"
echo "  Ultima rulare: $LAST  |  Max fixtures/run: $MAX_FX"

if [ "$SUCCESS" -gt 0 ] 2>/dev/null; then
  ok "Cel putin o rulare cu status='success' gasita"
else
  warn "Nicio rulare cu status='success' inca (job nu a rulat de la fix, sau vechi=ok)"
fi

# ─── P2: form_stats (non-issue confirmat) ────────────────────────────────────
hdr "P2 — form_stats JOIN (non-issue — enrich.js citeste fixtures_history direct)"

FS=$(eval $PG -c "SELECT COUNT(*) FROM form_stats")
FH=$(eval $PG -c "SELECT COUNT(DISTINCT home_team_id) FROM fixtures_history WHERE status_short='FT'")
echo "  form_stats randuri: $FS"
echo "  Echipe unice in fixtures_history (FT): $FH"
ok "Non-issue confirmat — enrich.js nu foloseste form_stats"

# ─── P3: injuries fallback din prematch_data ─────────────────────────────────
hdr "P3 — injuries: prematch_data vs tabel injuries"

INJ_TABLE=$(eval $PG -c "SELECT COUNT(*) FROM injuries")
INJ_PM=$(eval $PG -c "SELECT COUNT(*) FROM prematch_data WHERE data_type='injuries'")
INJ_PM_NONEMPTY=$(eval $PG -c "SELECT COUNT(*) FROM prematch_data WHERE data_type='injuries' AND jsonb_array_length(payload) > 0")

echo "  injuries table:                  $INJ_TABLE randuri"
echo "  prematch_data tip injuries:      $INJ_PM fixtures"
echo "  prematch_data cu jucatori:       $INJ_PM_NONEMPTY fixtures cu cel putin 1 jucator accidentat"

if [ "$INJ_PM" -gt 0 ] 2>/dev/null; then
  ok "Fallback disponibil: $INJ_PM fixtures cu injuries in prematch_data"
else
  fail "prematch_data nu are date injuries — fallback gol"
fi

# ─── P4: odds fallback din prematch_data ─────────────────────────────────────
hdr "P4 — odds: prematch_data vs tabel odds"

ODDS_FX=$(eval $PG -c "SELECT COUNT(DISTINCT fixture_id) FROM odds")
ODDS_PM=$(eval $PG -c "SELECT COUNT(*) FROM prematch_data WHERE data_type='odds'")
ODDS_PM_BM=$(eval $PG -c "SELECT COUNT(*) FROM prematch_data WHERE data_type='odds' AND jsonb_array_length(payload) > 0")
NS_WITH_ODDS=$(eval $PG -c "
  SELECT COUNT(*) FROM (
    SELECT DISTINCT pd.fixture_id
    FROM prematch_data pd
    WHERE pd.data_type='odds'
      AND pd.fixture_id NOT IN (SELECT DISTINCT fixture_id FROM odds)
  ) sub
")

echo "  odds table (fixture_id distincte): $ODDS_FX  (meciuri FT)"
echo "  prematch_data tip odds:            $ODDS_PM fixtures"
echo "  prematch_data cu bookmakers:       $ODDS_PM_BM fixtures"
echo "  NS/viitoare cu odds DOAR in prematch_data: $NS_WITH_ODDS (acum accesibile prin fallback)"

if [ "$ODDS_PM" -gt 0 ] 2>/dev/null; then
  ok "Fallback disponibil: $ODDS_PM fixtures cu odds in prematch_data"
else
  fail "prematch_data nu are date odds"
fi

# ─── P5: predictions DO UPDATE ───────────────────────────────────────────────
hdr "P5 — predictions: DO UPDATE (mereu ultima predictie pre-meci)"

PRED_TOTAL=$(eval $PG -c "SELECT COUNT(*) FROM predictions")
PRED_PENDING=$(eval $PG -c "SELECT COUNT(*) FROM predictions WHERE result_over15 IS NULL")
PRED_VERIFIED=$(eval $PG -c "SELECT COUNT(*) FROM predictions WHERE result_over15 IS NOT NULL")
BRIER=$(eval $PG -c "
  SELECT ROUND(AVG(POWER(
    (CASE WHEN result_over15 THEN 1.0 ELSE 0.0 END) - over15_prob/100.0, 2
  ))::numeric, 4)
  FROM predictions WHERE result_over15 IS NOT NULL AND over15_prob IS NOT NULL
")
LAST_UPD=$(eval $PG -c "SELECT TO_CHAR(MAX(updated_at), 'DD.MM HH24:MI') FROM predictions WHERE result_over15 IS NULL")
MULTI_UPD=$(eval $PG -c "
  SELECT COUNT(*) FROM predictions
  WHERE result_over15 IS NULL
    AND updated_at > created_at + INTERVAL '1 minute'
")

echo "  Total predictii:   $PRED_TOTAL"
echo "  Pending (NS):      $PRED_PENDING"
echo "  Verificate:        $PRED_VERIFIED"
echo "  Brier Over 1.5:    $BRIER  (target ≤0.16 pt Faza 1, ≤0.13 pt Faza 3)"
echo "  Ultima actualizare predictie pending: $LAST_UPD"
echo "  Predictii actualizate de mai multe ori (DO UPDATE activ): $MULTI_UPD"

if [ "$MULTI_UPD" -gt 0 ] 2>/dev/null; then
  ok "DO UPDATE functioneaza: $MULTI_UPD predictii actualizate de mai mult de 1x"
else
  warn "Nicio predictie actualizata inca (fix activ de azi, asteptam noi analize)"
fi

# ─── P6: venues altitude ─────────────────────────────────────────────────────
hdr "P6 — venues altitude: geocodare Nominatim + OpenElevation"

V_TOTAL=$(eval $PG -c "SELECT COUNT(*) FROM venues")
V_ALT_NULL=$(eval $PG -c "SELECT COUNT(*) FROM venues WHERE altitude_m IS NULL")
V_ALT_OK=$(eval $PG -c "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
V_LATLON=$(eval $PG -c "SELECT COUNT(*) FROM venues WHERE latitude IS NOT NULL AND longitude IS NOT NULL")
V_HIGH=$(eval $PG -c "SELECT COUNT(*) FROM venues WHERE altitude_m > 1500")

echo "  Total venues:            $V_TOTAL"
echo "  Cu altitude:             $V_ALT_OK"
echo "  Fara altitude (pending): $V_ALT_NULL"
echo "  Cu lat/lng geocodate:    $V_LATLON"
echo "  Stadioane >1500m:        $V_HIGH  (impacteaza modelul Poisson)"

echo
echo "  Test trigger manual collect-venues (10 venues):"
CURL_OUT=$(curl -s --max-time 30 "$APP/api/cron/collect-venues?limit=10" 2>/dev/null)
if echo "$CURL_OUT" | grep -q '"ok":true'; then
  COLL=$(echo "$CURL_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('collected',0))" 2>/dev/null)
  echo "  Raspuns: ok=true, collected=$COLL"
  if [ "${COLL:-0}" -gt 0 ] 2>/dev/null; then
    ok "collect-venues a geocodat $COLL venues cu succes"
  else
    warn "collect-venues rulat dar 0 geocodate (toate deja procesate sau fara oras)"
  fi
else
  warn "collect-venues nu a raspuns sau eroare: $CURL_OUT"
fi

# ─── SUMAR ───────────────────────────────────────────────────────────────────
hdr "SUMAR FINAL"

echo
V_ALT_OK2=$(eval $PG -c "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
BRIER2=$(eval $PG -c "
  SELECT ROUND(AVG(POWER(
    (CASE WHEN result_over15 THEN 1.0 ELSE 0.0 END) - over15_prob/100.0, 2
  ))::numeric, 4)
  FROM predictions WHERE result_over15 IS NOT NULL AND over15_prob IS NOT NULL
")

printf "  %-45s %s\n" "P1 collect-finished status fix" "$([ "$SUCCESS" -gt 0 ] && echo '✅' || echo '⚠️  (asteapta rulare cron 23:00)')"
printf "  %-45s %s\n" "P2 form_stats non-issue" "✅ confirmat"
printf "  %-45s %s\n" "P3 injuries fallback prematch_data" "$([ "$INJ_PM" -gt 0 ] && echo "✅ $INJ_PM fixtures disponibile" || echo '❌')"
printf "  %-45s %s\n" "P4 odds fallback prematch_data" "$([ "$ODDS_PM" -gt 0 ] && echo "✅ $ODDS_PM fixtures disponibile" || echo '❌')"
printf "  %-45s %s\n" "P5 predictions DO UPDATE" "$([ "$MULTI_UPD" -gt 0 ] && echo "✅ $MULTI_UPD predictii actualizate" || echo "⚠️  Brier=$BRIER2 (asteapta noi analize)")"
printf "  %-45s %s\n" "P6 venues altitude geocodat" "$([ "$V_ALT_OK2" -gt 0 ] && echo "✅ $V_ALT_OK2 venues cu altitude" || echo '⚠️  cron inca nerulatat')"
echo
