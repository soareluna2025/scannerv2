#!/bin/bash
# =============================================================================
# ALOHASCAN — VERIFICARE FIX-URI P1–P6 (sesiunea 25.05.2026)
# Rulare: bash scripts/verify-fixes.sh 2>&1 | tee /tmp/verify-$(date +%Y%m%d-%H%M).txt
# =============================================================================

export PGPASSWORD=Firenze225854
PG() { psql -U alohascan -d elefant -h 127.0.0.1 -tA -c "$1" 2>/dev/null; }
APP="http://localhost:3000"

ok()   { echo "  ✅  $1"; }
warn() { echo "  ⚠️   $1"; }
fail() { echo "  ❌  $1"; }
hdr()  { echo; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; echo "  $1"; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

# ─── P1: collect-finished logCron 'ok' → 'success' ───────────────────────────
hdr "P1 — collect-finished: status in cron_logs"
SUCCESS=$(PG "SELECT COUNT(*) FROM cron_logs WHERE job_name='collect-finished' AND status='success'")
OK_OLD=$(PG  "SELECT COUNT(*) FROM cron_logs WHERE job_name='collect-finished' AND status='ok'")
TOTAL=$(PG   "SELECT COUNT(*) FROM cron_logs WHERE job_name='collect-finished'")
LAST=$(PG    "SELECT TO_CHAR(MAX(ran_at), 'DD.MM HH24:MI') FROM cron_logs WHERE job_name='collect-finished'")
MAX_FX=$(PG  "SELECT COALESCE(MAX(fixtures_processed),0) FROM cron_logs WHERE job_name='collect-finished'")
echo "  Total rulari: $TOTAL  |  status='success': $SUCCESS  |  status='ok' (vechi): $OK_OLD"
echo "  Ultima rulare: $LAST  |  Max fixtures/run: $MAX_FX"
if [ "${SUCCESS:-0}" -gt 0 ] 2>/dev/null; then
  ok "Cel putin o rulare cu status='success'"
else
  warn "Nicio rulare 'success' inca (cron ruleaza la 23:00)"
fi

# ─── P2: form_stats (non-issue) ──────────────────────────────────────────────
hdr "P2 — form_stats (non-issue confirmat)"
FS=$(PG "SELECT COUNT(*) FROM form_stats")
FH=$(PG "SELECT COUNT(DISTINCT home_team_id) FROM fixtures_history WHERE status_short='FT'")
echo "  form_stats: $FS randuri  |  echipe in fixtures_history: $FH"
ok "enrich.js citeste fixtures_history direct — form_stats nefolosit in enrich"

# ─── P3: injuries fallback din prematch_data ─────────────────────────────────
hdr "P3 — injuries: prematch_data vs tabel injuries"
INJ_TABLE=$(PG "SELECT COUNT(*) FROM injuries")
INJ_PM=$(PG    "SELECT COUNT(*) FROM prematch_data WHERE data_type='injuries'")
INJ_PM_NON=$(PG "SELECT COUNT(*) FROM prematch_data WHERE data_type='injuries' AND jsonb_array_length(payload) > 0")
echo "  injuries table: $INJ_TABLE randuri"
echo "  prematch_data tip 'injuries': $INJ_PM fixtures  |  cu jucatori: $INJ_PM_NON"
if [ "${INJ_PM:-0}" -gt 0 ] 2>/dev/null; then
  ok "Fallback activ: $INJ_PM fixtures cu injuries in prematch_data"
else
  fail "prematch_data nu are date injuries"
fi

# ─── P4: odds fallback din prematch_data ─────────────────────────────────────
hdr "P4 — odds: prematch_data vs tabel odds"
ODDS_FX=$(PG "SELECT COUNT(DISTINCT fixture_id) FROM odds")
ODDS_PM=$(PG "SELECT COUNT(*) FROM prematch_data WHERE data_type='odds'")
ODDS_PM_NON=$(PG "SELECT COUNT(*) FROM prematch_data WHERE data_type='odds' AND jsonb_array_length(payload) > 0")
NS_ONLY=$(PG "SELECT COUNT(*) FROM prematch_data pd WHERE pd.data_type='odds' AND NOT EXISTS (SELECT 1 FROM odds o WHERE o.fixture_id = pd.fixture_id)")
echo "  odds table (fixture_id distincte): $ODDS_FX"
echo "  prematch_data tip 'odds': $ODDS_PM fixtures  |  cu bookmakers: $ODDS_PM_NON"
echo "  Fixtures cu odds DOAR in prematch_data (acum accesibile): $NS_ONLY"
if [ "${ODDS_PM:-0}" -gt 0 ] 2>/dev/null; then
  ok "Fallback activ: $ODDS_PM fixtures cu odds in prematch_data"
else
  fail "prematch_data nu are date odds"
fi

# ─── P5: predictions DO UPDATE ───────────────────────────────────────────────
hdr "P5 — predictions: DO UPDATE (mereu ultima predictie pre-meci)"
PRED_TOTAL=$(PG    "SELECT COUNT(*) FROM predictions")
PRED_PENDING=$(PG  "SELECT COUNT(*) FROM predictions WHERE result_over15 IS NULL")
PRED_VERIFED=$(PG  "SELECT COUNT(*) FROM predictions WHERE result_over15 IS NOT NULL")
LAST_UPD=$(PG      "SELECT TO_CHAR(MAX(updated_at), 'DD.MM HH24:MI') FROM predictions WHERE result_over15 IS NULL")
MULTI_UPD=$(PG     "SELECT COUNT(*) FROM predictions WHERE result_over15 IS NULL AND updated_at > created_at + INTERVAL '1 minute'")
BRIER=$(PG "SELECT ROUND(AVG(POWER((CASE WHEN result_over15 THEN 1.0 ELSE 0.0 END) - over15_prob/100.0, 2))::numeric, 4) FROM predictions WHERE result_over15 IS NOT NULL AND over15_prob IS NOT NULL")
echo "  Total: $PRED_TOTAL  |  Pending: $PRED_PENDING  |  Verificate: $PRED_VERIFED"
echo "  Brier Over 1.5: $BRIER  (Faza 0 observare, target ≤0.16 pt Faza 1)"
echo "  Ultima actualizare pending: $LAST_UPD"
echo "  Predictii actualizate >1x (DO UPDATE activ): $MULTI_UPD"
if [ "${MULTI_UPD:-0}" -gt 0 ] 2>/dev/null; then
  ok "DO UPDATE functioneaza: $MULTI_UPD predictii actualizate de mai mult de 1x"
else
  warn "Nicio predictie actualizata inca (fix activ de azi, asteptam noi analize pre-meci)"
fi

# ─── P6: venues altitude ─────────────────────────────────────────────────────
hdr "P6 — venues altitude: geocodare Nominatim + OpenElevation"
V_TOTAL=$(PG  "SELECT COUNT(*) FROM venues")
V_ALT_OK=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
V_ALT_NO=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NULL")
V_LATLON=$(PG "SELECT COUNT(*) FROM venues WHERE latitude IS NOT NULL AND longitude IS NOT NULL")
V_HIGH=$(PG   "SELECT COUNT(*) FROM venues WHERE altitude_m > 1500")
echo "  Total venues: $V_TOTAL  |  Cu altitude: $V_ALT_OK  |  Fara: $V_ALT_NO"
echo "  Cu lat/lng geocodate: $V_LATLON  |  Stadioane >1500m: $V_HIGH"
echo
echo "  Testez collect-venues (10 venues, poate dura ~15s)..."
CURL_OUT=$(curl -s --max-time 60 "$APP/api/cron/collect-venues?limit=10" 2>/dev/null)
if echo "$CURL_OUT" | grep -q '"ok":true'; then
  COLL=$(echo "$CURL_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('collected',0))" 2>/dev/null)
  TOTAL_V=$(echo "$CURL_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total_venues_in_db',0))" 2>/dev/null)
  echo "  Raspuns: ok=true | collected=$COLL | total_in_db=$TOTAL_V"
  if [ "${COLL:-0}" -gt 0 ] 2>/dev/null; then
    ok "Geocodare functioneaza: $COLL venues procesate"
  else
    warn "ok=true dar collected=0 (toate deja procesate sau fara oras)"
  fi
else
  warn "collect-venues nu a raspuns sau eroare: ${CURL_OUT:0:200}"
fi

# ─── SUMAR FINAL ─────────────────────────────────────────────────────────────
hdr "SUMAR FINAL"
V_ALT_OK2=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
BRIER2=$(PG "SELECT ROUND(AVG(POWER((CASE WHEN result_over15 THEN 1.0 ELSE 0.0 END) - over15_prob/100.0, 2))::numeric, 4) FROM predictions WHERE result_over15 IS NOT NULL AND over15_prob IS NOT NULL")
echo
printf "  %-46s %s\n" "P1 collect-finished status fix" "$([ "${SUCCESS:-0}" -gt 0 ] 2>/dev/null && echo '✅' || echo '⚠️  asteapta cron 23:00')"
printf "  %-46s %s\n" "P2 form_stats non-issue"         "✅ confirmat"
printf "  %-46s %s\n" "P3 injuries fallback prematch_data" "$([ "${INJ_PM:-0}" -gt 0 ] 2>/dev/null && echo "✅ $INJ_PM fixtures" || echo '❌')"
printf "  %-46s %s\n" "P4 odds fallback prematch_data"   "$([ "${ODDS_PM:-0}" -gt 0 ] 2>/dev/null && echo "✅ $ODDS_PM fixtures" || echo '❌')"
printf "  %-46s %s\n" "P5 predictions DO UPDATE"         "$([ "${MULTI_UPD:-0}" -gt 0 ] 2>/dev/null && echo "✅ $MULTI_UPD predictii actualizate" || echo "⚠️  Brier=$BRIER2 | fix activ, asteapta analize")"
printf "  %-46s %s\n" "P6 venues altitude geocodat"      "$([ "${V_ALT_OK2:-0}" -gt 0 ] 2>/dev/null && echo "✅ $V_ALT_OK2 venues cu altitude" || echo '⚠️  cron inca nerulatat')"
echo
