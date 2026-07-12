#!/usr/bin/env bash
# ============================================================================
#  scripts/db-full-scan.sh  —  SCANARE READ-ONLY COMPLETĂ a bazei AlohaScan.
#  DOAR SELECT-uri (zero UPDATE/INSERT/DELETE/DDL). Output text îngust (~80 col),
#  citibil pe iPhone.  Rulare (o linie Termius):
#     cd /root/scannerv2 && git pull && bash scripts/db-full-scan.sh
#  (opțional în fișier:  ... bash scripts/db-full-scan.sh | tee /tmp/dbscan.txt)
#
#  PARTEA 1 — fișa fiecărei tabele (rânduri, mărime, coloane, coloană temporală,
#             min→max, rânduri 7 zile, 1 rând-exemplu, chei JSON).
#  PARTEA 2 — vânătoarea cartonașe & cornere: coloane pe nume, acoperire pe FT
#             whitelist, interiorul JSON-urilor, match_events, VERDICT.
#  Robust: eroare pe o tabelă → „EROARE", scanarea continuă. Tabele uriașe →
#          COUNT estimat (~reltuples) + fără sort greu (țintă < 2 min).
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." 2>/dev/null || true
[ -f ./.env ] && { set -a; . ./.env 2>/dev/null; set +a; }
if [ -z "${POSTGRES_URL:-}" ]; then echo "EROARE: POSTGRES_URL lipsă (sursă .env)"; exit 1; fi

# psql tăcut, pipe-separated, ON_ERROR_STOP=0 (o eroare nu oprește restul).
Q(){ psql "$POSTGRES_URL" -X -q -At -F'|' -v ON_ERROR_STOP=0 -c "$1" 2>/dev/null; }
Q1(){ psql "$POSTGRES_URL" -X -q -At -v ON_ERROR_STOP=0 -c "$1" 2>/dev/null; }
sep(){ printf -- '----------------------------------------------------------------\n'; }
big(){ printf '\n================================================================\n %s\n================================================================\n' "$1"; }

# ── Whitelist (SURSĂ UNICĂ: ml/allowed_leagues.json → fallback api/leagues.js) ──
WL=""
[ -f ml/allowed_leagues.json ] && WL="$(node -e "process.stdout.write(require('./ml/allowed_leagues.json').join(','))" 2>/dev/null)"
[ -z "$WL" ] && WL="$(node -e "import('./api/leagues.js').then(m=>process.stdout.write([...m.ALLOWED_LEAGUE_IDS].join(',')))" 2>/dev/null)"
[ -z "$WL" ] && WL="0"
WLN="$(printf '%s' "$WL" | awk -F, '{print NF}')"
FT="('FT','AET','PEN')"        # statusuri „meci jucat"

echo   "AlohaScan — DB FULL SCAN  ($(Q1 "SELECT now()"))"
printf "Whitelist ligi: %s  ·  DB: %s\n" "$WLN" "$(Q1 "SELECT current_database()||' '||pg_size_pretty(pg_database_size(current_database()))")"

# Denumitori de acoperire (FT whitelist) — folosiți în Partea 2.
DEN7="$(Q1 "SELECT count(*) FROM fixtures_history fh WHERE fh.status_short IN $FT AND fh.league_id = ANY(ARRAY[$WL]) AND fh.match_date >= now()-interval '7 days'")"; DEN7="${DEN7:-0}"
DEN24="$(Q1 "SELECT count(*) FROM fixtures_history fh WHERE fh.status_short IN $FT AND fh.league_id = ANY(ARRAY[$WL]) AND fh.match_date >= '2024-01-01' AND fh.match_date < '2026-01-01'")"; DEN24="${DEN24:-0}"
pct(){ awk -v n="${1:-0}" -v d="${2:-0}" 'BEGIN{ if(d+0>0) printf "%.1f%%", 100*n/d; else printf "n/a" }'; }

# ════════════════════════════════════════════════════════════════════════════
big "PARTEA 1 — FIȘA FIECĂREI TABELE"
# ════════════════════════════════════════════════════════════════════════════
TBLS="$(Q "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname")"
TCAND="match_date,created_at,updated_at,ran_at,sent_at,executed_at,collected_at,generated_at,last_updated,ts,date,day"

for T in $TBLS; do
  ( # subshell: o eroare pe tabelă NU oprește bucla
    EST="$(Q1 "SELECT c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='$T'")"; EST="${EST:-0}"
    SIZE="$(Q1 "SELECT pg_size_pretty(pg_total_relation_size('public.$T'::regclass))")"; SIZE="${SIZE:---}"
    # rânduri: exact dacă est<5M sau necunoscut; altfel ~reltuples
    if [ "$EST" -lt 0 ] 2>/dev/null || [ "$EST" -lt 5000000 ] 2>/dev/null; then
      ROWS="$(Q1 "SELECT count(*) FROM public.\"$T\"")"; ROWS="${ROWS:-EROARE}"
    else
      ROWS="~$EST"
    fi
    sep; printf "TABEL: %s   rânduri=%s   mărime=%s\n" "$T" "$ROWS" "$SIZE"

    # coloane (nume + tip scurt udt_name)
    COLS="$(Q1 "SELECT string_agg(column_name||' '||udt_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='$T'")"
    printf "  col: %s\n" "${COLS:-?}"

    # coloană temporală (prima din listă care există)
    TC="$(Q1 "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='$T' AND column_name = ANY(string_to_array('$TCAND',',')) ORDER BY array_position(string_to_array('$TCAND',','), column_name) LIMIT 1")"
    if [ -n "$TC" ]; then
      if [ "$EST" -ge 0 ] 2>/dev/null && [ "$EST" -lt 3000000 ] 2>/dev/null; then
        MM="$(Q "SELECT min(\"$TC\")::text||' → '||max(\"$TC\")::text, count(*) FILTER (WHERE \"$TC\" >= now()-interval '7 days') FROM public.\"$T\"")"
        RANGE="$(printf '%s' "$MM" | cut -d'|' -f1)"; L7="$(printf '%s' "$MM" | cut -d'|' -f2)"
        printf "  timp[%s]: %s   ·   ultimele 7 zile: %s rânduri  → %s\n" "$TC" "${RANGE:-?}" "${L7:-0}" "$([ "${L7:-0}" -gt 0 ] 2>/dev/null && echo VIE || echo 'moartă?')"
      else
        printf "  timp[%s]: — (tabel mare, sărit pt viteză)\n" "$TC"
      fi
    else
      printf "  timp: — (fără coloană temporală)\n"
    fi

    # 1 rând-exemplu (rândul cast la text, trunchiat). Sort DESC doar pe tabele mici.
    if [ -n "$TC" ] && [ "$EST" -lt 2000000 ] 2>/dev/null; then
      SAMP="$(Q1 "SELECT left(x::text, 480) FROM public.\"$T\" x ORDER BY \"$TC\" DESC LIMIT 1")"
    else
      SAMP="$(Q1 "SELECT left(x::text, 480) FROM public.\"$T\" x LIMIT 1")"
    fi
    printf "  ex: %s\n" "${SAMP:-(gol)}"

    # coloane JSON/JSONB → chei de nivel 1 dintr-un eșantion de 100
    JCOLS="$(Q "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='$T' AND udt_name IN ('json','jsonb')")"
    for JC in $JCOLS; do
      KEYS="$(Q1 "SELECT string_agg(DISTINCT key, ', ') FROM (SELECT v FROM (SELECT (\"$JC\")::jsonb v FROM public.\"$T\" WHERE \"$JC\" IS NOT NULL LIMIT 100) s0 WHERE jsonb_typeof(v)='object') s, LATERAL jsonb_object_keys(s.v) AS key")"
      printf "  json[%s] chei: %s\n" "$JC" "${KEYS:-(non-obiect/gol)}"
    done
  ) || printf "  EROARE la tabela %s (continuă)\n" "$T"
done

# ════════════════════════════════════════════════════════════════════════════
big "PARTEA 2 — VÂNĂTOARE: CARTONAȘE & CORNERE"
# ════════════════════════════════════════════════════════════════════════════

echo "[2a] Coloane pe NUME (card/yellow/red/corner/foul/booking):"
Q "SELECT '  '||table_name||'.'||column_name||'  ['||udt_name||']' FROM information_schema.columns WHERE table_schema='public' AND (column_name ~* 'card|yellow|red|corner|foul|booking') ORDER BY table_name, column_name" || echo "  EROARE"

echo
echo "[2b] Acoperire pe FT WHITELIST pentru fiecare coloană găsită (are fixture_id → join meci):"
printf "     denumitori FT WL: 7z=%s · 2024-25=%s\n" "$DEN7" "$DEN24"
# perechi (tabel|coloană|udt) pentru coloanele-țintă
PAIRS="$(Q "SELECT table_name||'|'||column_name||'|'||udt_name FROM information_schema.columns WHERE table_schema='public' AND (column_name ~* 'card|yellow|red|corner|foul|booking')")"
printf '%s\n' "$PAIRS" | while IFS='|' read -r TB CO UD; do
  [ -z "$TB" ] && continue
  HASF="$(Q1 "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$TB' AND column_name='fixture_id' LIMIT 1")"
  if [ "$HASF" = "1" ]; then
    # numeric → putem calcula % >0; altfel doar % non-null
    POSEXPR="NULL"
    case "$UD" in int2|int4|int8|numeric|float4|float8) POSEXPR="round(100.0*count(*) FILTER (WHERE t.\"$CO\">0)/nullif(count(*),0),1)";; esac
    R="$(Q "SELECT count(*), round(100.0*count(*) FILTER (WHERE t.\"$CO\" IS NOT NULL)/nullif(count(*),0),1), $POSEXPR FROM public.\"$TB\" t JOIN fixtures_history fh ON fh.fixture_id=t.fixture_id WHERE fh.status_short IN $FT AND fh.league_id=ANY(ARRAY[$WL]) AND fh.match_date>='2024-01-01' AND fh.match_date<'2026-01-01'")"
    printf "  %-34s 2024-25: n=%s nonNULL=%s%% >0=%s%%\n" "$TB.$CO" "$(echo "$R"|cut -d'|' -f1)" "$(echo "$R"|cut -d'|' -f2)" "$(echo "$R"|cut -d'|' -f3)"
  else
    R="$(Q "SELECT count(*), round(100.0*count(*) FILTER (WHERE \"$CO\" IS NOT NULL)/nullif(count(*),0),1) FROM public.\"$TB\"")"
    printf "  %-34s (fără fixture_id) total=%s nonNULL=%s%%\n" "$TB.$CO" "$(echo "$R"|cut -d'|' -f1)" "$(echo "$R"|cut -d'|' -f2)"
  fi
done

echo
echo "[2c] Interiorul JSON-urilor (sondaj 200 rânduri; caut card/corner/yellow/red/foul):"
Q "SELECT table_name||'|'||column_name FROM information_schema.columns WHERE table_schema='public' AND udt_name IN ('json','jsonb')" | while IFS='|' read -r TB JC; do
  [ -z "$TB" ] && continue
  HIT="$(Q1 "SELECT count(*) FROM (SELECT 1 FROM public.\"$TB\" WHERE \"$JC\"::text ~* 'card|corner|yellow|red|foul|booking' LIMIT 200) s")"
  if [ "${HIT:-0}" -gt 0 ] 2>/dev/null; then
    KEYS="$(Q1 "SELECT string_agg(DISTINCT key, ', ') FROM (SELECT v FROM (SELECT (\"$JC\")::jsonb v FROM public.\"$TB\" WHERE \"$JC\" IS NOT NULL LIMIT 200) s0 WHERE jsonb_typeof(v)='object') s, LATERAL jsonb_object_keys(s.v) AS key WHERE key ~* 'card|corner|yellow|red|foul|booking'")"
    EX="$(Q1 "SELECT left(\"$JC\"::text, 160) FROM public.\"$TB\" WHERE \"$JC\"::text ~* 'corner|card|yellow|foul' LIMIT 1")"
    printf "  ⚑ %s.%s  chei: %s\n     ex: %s\n" "$TB" "$JC" "${KEYS:-(text, fără cheie top)}" "${EX:-?}"
  fi
done
echo "  (dacă nu apare nimic → niciun JSON nu conține cartonașe/cornere)"

echo
echo "[2d] match_events (type='Card') — meciuri FT WL reconstruibile din evenimente:"
MEV7="$(Q1 "SELECT count(DISTINCT me.fixture_id) FROM match_events me JOIN fixtures_history fh ON fh.fixture_id=me.fixture_id WHERE me.type='Card' AND fh.status_short IN $FT AND fh.league_id=ANY(ARRAY[$WL]) AND fh.match_date>=now()-interval '7 days'")"; MEV7="${MEV7:-0}"
MEV24="$(Q1 "SELECT count(DISTINCT me.fixture_id) FROM match_events me JOIN fixtures_history fh ON fh.fixture_id=me.fixture_id WHERE me.type='Card' AND fh.status_short IN $FT AND fh.league_id=ANY(ARRAY[$WL]) AND fh.match_date>='2024-01-01' AND fh.match_date<'2026-01-01'")"; MEV24="${MEV24:-0}"
printf "  7z: %s / %s (%s)  ·  2024-25: %s / %s (%s)\n" "$MEV7" "$DEN7" "$(pct "$MEV7" "$DEN7")" "$MEV24" "$DEN24" "$(pct "$MEV24" "$DEN24")"

# ── surse „cunoscute" pt VERDICT (cifre reale) ──
echo
echo "[2e] VERDICT — izvoare cartonașe & cornere (acoperire FT WL 2024-25):"
covfix(){ # $1=tabel $2=coloană(non-null) → nr meciuri FT WL 2024-25 cu acea coloană
  Q1 "SELECT count(DISTINCT t.fixture_id) FROM public.\"$1\" t JOIN fixtures_history fh ON fh.fixture_id=t.fixture_id WHERE t.\"$2\" IS NOT NULL AND fh.status_short IN $FT AND fh.league_id=ANY(ARRAY[$WL]) AND fh.match_date>='2024-01-01' AND fh.match_date<'2026-01-01'"; }
MS_C="$(covfix match_stats yellow_cards)"; MS_C="${MS_C:-0}"
MS_K="$(covfix match_stats corner_kicks)"; MS_K="${MS_K:-0}"
PS_C="$(covfix player_stats yellow_cards)"; PS_C="${PS_C:-0}"
RS_ROWS="$(Q1 "SELECT count(*) FROM referee_stats WHERE avg_yellow_cards IS NOT NULL")"; RS_ROWS="${RS_ROWS:-0}"

echo   "  CARTONAȘE (meciuri FT WL 2024-25 = $DEN24):"
printf "    match_stats.yellow/red_cards : %s  (%s)\n"        "$MS_C"   "$(pct "$MS_C" "$DEN24")"
printf "    match_events type='Card'     : %s  (%s)\n"        "$MEV24"  "$(pct "$MEV24" "$DEN24")"
printf "    player_stats.yellow_cards    : %s  (%s)\n"        "$PS_C"   "$(pct "$PS_C" "$DEN24")"
printf "    referee_stats.avg_yellow     : %s arbitri (agregat, nu per-meci)\n" "$RS_ROWS"
echo   "  CORNERE (meciuri FT WL 2024-25 = $DEN24):"
printf "    match_stats.corner_kicks     : %s  (%s)\n"        "$MS_K"   "$(pct "$MS_K" "$DEN24")"
echo   "    match_events                 : cornerele NU sunt evenimente în API-Football (aștept ~0)"
echo   "    JSON (vezi [2c])             : dacă prematch_data/h2h conțin corner → sursă alternativă"
echo
echo "  Interpretare: cea mai plină sursă (procent maxim de mai sus) e cea de folosit"
echo "  pt hrănit modelele. Dacă TOATE sub ~15-20% → date insuficiente pe whitelist"
echo "  (confirmă diagnoza robinet match_stats). referee_stats = folosește-l ca"
echo "  feature de ARBITRU (per-meci prin join pe referee), nu ca sursă per-meci."
echo
echo "── GATA. Rulează din nou după orice backfill ca să vezi acoperirea crescând. ──"
