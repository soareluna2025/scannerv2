#!/bin/bash
# ============================================================================
#  admin-audit.sh — DIAGNOSTIC runtime pentru cron-uri (read-only). Confirmă pe
#  VPS ce e viu/mort. Credențiale din .env (POSTGRES_URL), zero parole în output.
#  Output: consolă + /root/scannerv2/docs/ADMIN_AUDIT_RUNTIME.txt
#  Rulare:  bash scripts/admin-audit.sh
# ============================================================================
APP_DIR="/root/scannerv2"
OUT="${APP_DIR}/docs/ADMIN_AUDIT_RUNTIME.txt"
mkdir -p "${APP_DIR}/docs"
exec > >(tee "${OUT}") 2>&1
set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi
P(){ psql "${PGURL}" -X -v ON_ERROR_STOP=0 -P pager=off "$@"; }
SEC(){ echo ""; echo "════════════════════════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════════════════════════"; }
Q(){ echo ""; echo "── $1 ──"; P -c "$2" || echo "  (eroare, continuă)"; }

echo "ADMIN AUDIT RUNTIME — $(date '+%Y-%m-%d %H:%M:%S')"

# 1 — crontab real (programarea efectivă)
SEC "1. crontab -l (programarea REALĂ de pe VPS)"
crontab -l 2>&1 | grep -vE '^\s*#|^\s*$' || echo "  (crontab gol sau inaccesibil)"

# Detectare nume coloane în cron_logs (job_name/status/duration/ran_at variază).
JOBCOL=$(P -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='cron_logs' AND column_name IN ('job_name','job') LIMIT 1")
TSCOL=$(P -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='cron_logs' AND column_name IN ('ran_at','created_at','run_at') LIMIT 1")
DURCOL=$(P -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='cron_logs' AND column_name IN ('duration_ms','duration') LIMIT 1")
STCOL=$(P -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='cron_logs' AND column_name='status' LIMIT 1")
JOBCOL=${JOBCOL:-job_name}; TSCOL=${TSCOL:-ran_at}; DURCOL=${DURCOL:-duration_ms}
echo ""; echo "  (cron_logs: job=${JOBCOL} ts=${TSCOL} dur=${DURCOL} status=${STCOL:-<niciuna>})"

# 2 — per job: rulări 30z, ultima, durată medie, erori
SEC "2. cron_logs — per job (ultimele 30 zile)"
if [ -n "${STCOL}" ]; then ERREXPR="COUNT(*) FILTER (WHERE lower(${STCOL}) IN ('error','fail','failed'))"; else ERREXPR="0"; fi
Q "rulări / ultima / durată medie / erori" "
SELECT ${JOBCOL} AS job,
       COUNT(*) AS rulari_30z,
       MAX(${TSCOL}) AS ultima,
       ROUND(AVG(${DURCOL})::numeric/1000,1) AS durata_med_s,
       ${ERREXPR} AS erori
FROM cron_logs
WHERE ${TSCOL} >= NOW() - INTERVAL '30 days'
GROUP BY ${JOBCOL} ORDER BY rulari_30z DESC;"

# 3 — joburi din COD dar ABSENTE din cron_logs (zombi confirmați runtime)
SEC "3. Joburi în COD dar FĂRĂ rulări în 30 zile (zombi confirmați)"
echo "Joburi cron din cod (api/cron/*.js):"
CODE_JOBS=$(ls "${APP_DIR}/api/cron/"*.js 2>/dev/null | xargs -n1 basename | sed 's/.js$//' | sort)
echo "$CODE_JOBS" | tr '\n' ' '; echo ""
echo ""
echo "Comparație cu cron_logs (30z):"
RAN=$(P -tAc "SELECT DISTINCT ${JOBCOL} FROM cron_logs WHERE ${TSCOL} >= NOW() - INTERVAL '30 days'" 2>/dev/null | sed 's/^cron-//' | sort -u)
for j in $CODE_JOBS; do
  if echo "$RAN" | grep -qiE "^${j}$|^cron-${j}$"; then :; else echo "  🧟 $j — 0 rulări în cron_logs (30z)"; fi
done
echo "  (notă: scanner rulează intern prin setInterval, NU scrie cron_logs → ignoră-l;"
echo "   joburile pornite manual/prin cazarma-router pot apărea aici fără a fi moarte.)"

# 4 — top 5 joburi după durată medie (candidați de optimizat)
SEC "4. Top 5 joburi după durată medie (candidați de optimizat)"
Q "durată medie" "
SELECT ${JOBCOL} AS job, COUNT(*) AS rulari,
       ROUND(AVG(${DURCOL})::numeric/1000,1) AS durata_med_s,
       ROUND(MAX(${DURCOL})::numeric/1000,1) AS durata_max_s
FROM cron_logs
WHERE ${TSCOL} >= NOW() - INTERVAL '30 days' AND ${DURCOL} IS NOT NULL
GROUP BY ${JOBCOL} HAVING COUNT(*) >= 1
ORDER BY AVG(${DURCOL}) DESC LIMIT 5;"

echo ""; echo "GATA. Salvat în: ${OUT}"
