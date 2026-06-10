#!/bin/bash
# ============================================================================
#  ml-audit.sh — AUDIT ML AlohaScan (PASUL 1-7 din docs/ML_AUDIT_2026-06-10.md)
#  într-o SINGURĂ comandă, pe VPS.
#
#  • Credențiale DB EXCLUSIV din /root/scannerv2/.env (POSTGRES_URL). ZERO
#    parole hardcodate aici.
#  • Output pe consolă ȘI salvat în /root/scannerv2/docs/ML_AUDIT_RESULTS.txt.
#  • Tolerant la erori: un pas eșuat (tabel/fișier lipsă) afișează eroarea și
#    CONTINUĂ cu următorul (fără set -e; ON_ERROR_STOP=0 pe psql).
#
#  Rulare:  bash scripts/ml-audit.sh
# ============================================================================

APP_DIR="/root/scannerv2"
OUT="${APP_DIR}/docs/ML_AUDIT_RESULTS.txt"
mkdir -p "${APP_DIR}/docs"

# Tot output-ul → consolă + fișier (process substitution, bash).
exec > >(tee "${OUT}") 2>&1

# Credențiale din .env (NU hardcodăm nimic).
set -a
. "${APP_DIR}/.env" 2>/dev/null
set +a

PGURL="${POSTGRES_URL:-}"

sep() {
  echo ""
  echo "════════════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "════════════════════════════════════════════════════════════════════════"
}

# Rulează un SQL tolerant: niciun ON_ERROR_STOP, prinde lipsa conexiunii/tabelei.
run_sql() {
  local label="$1"; shift
  local sql="$1"
  echo ""
  echo "── ${label} ─────────────────────────────────────────────"
  if [ -z "${PGURL}" ]; then
    echo "  ⚠ POSTGRES_URL lipsește din .env — pas DB sărit."
    return 0
  fi
  psql "${PGURL}" -X -v ON_ERROR_STOP=0 -c "${sql}" 2>&1 \
    || echo "  ⚠ eroare la pasul: ${label} (continuă)."
}

echo "AUDIT ML AlohaScan — $(date '+%Y-%m-%d %H:%M:%S')"
echo "Repo: ${APP_DIR}  ·  Output: ${OUT}"
echo "DB: $( [ -n "${PGURL}" ] && echo 'POSTGRES_URL încărcat din .env' || echo 'POSTGRES_URL ABSENT' )"

cd "${APP_DIR}" || { echo "Nu pot cd în ${APP_DIR}"; exit 1; }

# ────────────────────────────────────────────────────────────────────────────
sep "PASUL 1 — Starea exporturilor (mtime, piețe, features, N, brier)"
python3 - <<'PY' 2>&1 || echo "  ⚠ eroare PASUL 1 (python3/json) — continuă."
import json, os, datetime
for f in ['ml/model_export.json', 'ml/model_live_export.json']:
    if not os.path.exists(f):
        print(f"\n### {f}: LIPSEȘTE"); continue
    st = os.stat(f); m = json.load(open(f))
    print(f"\n### {f}")
    print("  mtime:", datetime.datetime.fromtimestamp(st.st_mtime))
    print("  nr. piețe:", len(m))
    nfeat = sorted({len(v.get('features', [])) for v in m.values()})
    print("  nr. features distinct:", nfeat)
    first = next(iter(m.values()))
    print("  features:", first.get('features'))
    for k, v in m.items():
        print(f"   - {k}: N={v.get('n_samples')} brier_lr={v.get('brier_lr')} "
              f"brier_gb={v.get('brier_gb')} brier_baseline={v.get('brier_baseline')} "
              f"base_rate={v.get('base_rate')} classes={v.get('classes')}")
PY

# ────────────────────────────────────────────────────────────────────────────
sep "PASUL 2 — Tabel per piață (bate baseline DA/NU)"
python3 - <<'PY' 2>&1 || echo "  ⚠ eroare PASUL 2 — continuă."
import json, os
def base_brier(v):
    if v.get('classes'): return None  # multiclass: baseline real cere freq. tuturor claselor
    if v.get('brier_baseline') is not None: return v['brier_baseline']
    br = v.get('base_rate')
    return round(br*(1-br), 4) if br is not None else None
rows = []
for f in ['ml/model_export.json', 'ml/model_live_export.json']:
    if not os.path.exists(f): continue
    for k, v in json.load(open(f)).items():
        b = v.get('brier_lr'); bb = base_brier(v)
        flag = '—' if bb is None else ('DA' if (b is not None and b < bb) else 'NU')
        dif = None if (b is None or bb is None) else round(bb - b, 4)
        rows.append((os.path.basename(f).replace('model_','').replace('.json',''),
                     k, v.get('n_samples'), b, bb, flag, dif))
print(f"{'model':10} {'piață':26} {'N':>7} {'brier':>8} {'base':>8} {'bate':>5} {'dif':>8}")
for r in rows:
    print(f"{r[0]:10} {r[1]:26} {str(r[2]):>7} {str(r[3]):>8} {str(r[4]):>8} {r[5]:>5} {str(r[6]):>8}")
known = [r for r in rows if r[5] in ('DA','NU')]
beat = sum(1 for r in known if r[5]=='DA')
print(f"\nBat baseline: {beat}/{len(known)} (piețe binare cu baseline calculabil)")
print("NU bat:", [r[1] for r in known if r[5]=='NU'])
print("Multiclass (baseline n/a):", [r[1] for r in rows if r[5]=='—'])
PY

# ────────────────────────────────────────────────────────────────────────────
sep "PASUL 3 — Sănătatea antrenărilor (loguri + cron_logs + crontab)"
echo "── ml/train.log (ultimele 40 linii) ──"
tail -n 40 "${APP_DIR}/ml/train.log" 2>&1 || echo "  ⚠ ml/train.log absent."
echo ""
echo "── /root/.pm2/logs/train-live-v2.log (ultimele 40 linii) ──"
tail -n 40 /root/.pm2/logs/train-live-v2.log 2>&1 || echo "  ⚠ train-live-v2.log absent."
run_sql "cron_logs (train / ml-features, ultimele 14)" \
  "SELECT * FROM cron_logs WHERE job ILIKE '%train%' OR job ILIKE '%ml-features%' OR job ILIKE '%ml_features%' ORDER BY created_at DESC LIMIT 14;"
echo ""
echo "── crontab — linii ML ──"
crontab -l 2>/dev/null | grep -E 'train_model|train_live|build-ml-features|train-model|train-live' \
  || echo "  ⚠ nicio linie ML în crontab (sau crontab gol)."

# ────────────────────────────────────────────────────────────────────────────
sep "PASUL 4 — Date de antrenare"
run_sql "ml_features rows + remaining + live_stats fixtures" \
  "SELECT
     (SELECT COUNT(*) FROM ml_features) AS ml_features_rows,
     (SELECT COUNT(*) FROM predictions p
        WHERE p.result_over15 IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ml_features f WHERE f.fixture_id=p.fixture_id)) AS remaining_fara_features,
     (SELECT COUNT(DISTINCT fixture_id) FROM live_stats) AS live_stats_fixtures;"
run_sql "prediction_log per modul/outcome" \
  "SELECT module, outcome, COUNT(*) FROM prediction_log GROUP BY 1,2 ORDER BY 1,2;"
run_sql "PENDING dar meciul deja FT (nerezolvate blocate)" \
  "SELECT pl.module, COUNT(*) AS pending_dar_terminat
     FROM prediction_log pl
     JOIN fixtures_history fh ON fh.fixture_id = pl.fixture_id
    WHERE pl.outcome='PENDING' AND fh.status_short IN ('FT','AET','PEN')
    GROUP BY pl.module ORDER BY 2 DESC;"

# ────────────────────────────────────────────────────────────────────────────
sep "PASUL 5 — Calibrare over15_prob pe bucket-uri 40-100 (ultimele 90 zile)"
run_sql "calibrare (N | prezis | real | dif pp)" \
  "WITH b AS (
     SELECT CASE
              WHEN over15_prob >= 90 THEN '90-100'
              WHEN over15_prob >= 80 THEN '80-90'
              WHEN over15_prob >= 70 THEN '70-80'
              WHEN over15_prob >= 60 THEN '60-70'
              WHEN over15_prob >= 50 THEN '50-60'
              WHEN over15_prob >= 40 THEN '40-50'
              ELSE '<40' END AS bucket,
            over15_prob AS p, CASE WHEN result_over15 THEN 1 ELSE 0 END AS y
     FROM predictions
     WHERE result_over15 IS NOT NULL AND match_date >= NOW() - INTERVAL '90 days')
   SELECT bucket, COUNT(*) n, ROUND(AVG(p),1) AS pred_avg,
          ROUND(100.0*AVG(y),1) AS real_rate,
          ROUND(100.0*AVG(y)-AVG(p),1) AS dif_pp,
          CASE WHEN ABS(100.0*AVG(y)-AVG(p)) > 5 THEN '⚠>5pp' ELSE 'ok' END AS flag
   FROM b GROUP BY bucket ORDER BY bucket;"

# ────────────────────────────────────────────────────────────────────────────
sep "PASUL 6 — Acoperire cote NS 48h + piețe (bet_name)"
run_sql "fixturi NS 48h cu cote / total NS 48h" \
  "SELECT
     (SELECT COUNT(DISTINCT pd.fixture_id) FROM prematch_data pd
        JOIN fixtures f ON f.fixture_id = pd.fixture_id
       WHERE pd.data_type='odds' AND f.status_short='NS'
         AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '48 hours') AS ns_cu_cote,
     (SELECT COUNT(*) FROM fixtures
       WHERE status_short='NS' AND match_date BETWEEN NOW() AND NOW() + INTERVAL '48 hours') AS ns_total_48h;"
run_sql "bet_name distincte (sample 20 payload-uri odds)" \
  "SELECT DISTINCT bet ->> 'name' AS bet_name
     FROM (SELECT payload FROM prematch_data WHERE data_type='odds' LIMIT 20) s,
          jsonb_array_elements(s.payload->'bookmakers') bk,
          jsonb_array_elements(bk->'bets') bet
    ORDER BY 1;"
echo ""
echo "  (dacă query-ul de mai sus dă eroare → structura payload diferă; inspectează:"
echo "   psql \"\$POSTGRES_URL\" -c \"SELECT payload FROM prematch_data WHERE data_type='odds' LIMIT 1;\")"

# ────────────────────────────────────────────────────────────────────────────
sep "PASUL 7 — Win rate Over1.5 per ligă (180 zile, min 30 meciuri)"
run_sql "TOP 10 + BOTTOM 10 ligi" \
  "WITH lg AS (
     SELECT league_name, COUNT(*) n,
            ROUND(100.0*AVG(CASE WHEN result_over15 THEN 1 ELSE 0 END),1) wr
     FROM predictions
     WHERE result_over15 IS NOT NULL AND match_date >= NOW() - INTERVAL '180 days'
     GROUP BY league_name HAVING COUNT(*) >= 30)
   (SELECT 'TOP' AS tip, league_name, n, wr FROM lg ORDER BY wr DESC LIMIT 10)
   UNION ALL
   (SELECT 'BOTTOM' AS tip, league_name, n, wr FROM lg ORDER BY wr ASC LIMIT 10)
   ORDER BY tip DESC, wr DESC;"

sep "AUDIT COMPLET — $(date '+%Y-%m-%d %H:%M:%S')"
echo "Rezultate salvate în: ${OUT}"
