#!/usr/bin/env bash
# vps-doctor.sh — DIAGNOSTIC READ-ONLY pe VPS: cod, PM2, health, ponturi, DB, cron, SSH, resurse.
# NU modifică nimic. Rulare (o singură linie, din Termius):
#   cd /root/scannerv2 && git fetch -q origin && git checkout origin/main -- scripts/vps-doctor.sh && bash scripts/vps-doctor.sh
set -u
export PATH="/snap/bin:/usr/local/bin:$PATH"
cd /root/scannerv2 || { echo "EROARE: /root/scannerv2 nu există"; exit 1; }
set -a; . ./.env 2>/dev/null; set +a
hr() { echo; echo "=== $* ==="; }

hr "COD"
echo "HEAD local : $(git rev-parse --short HEAD) ($(git log -1 --format=%cd --date=format:%d.%m.%Y_%H:%M))"
if git fetch -q origin 2>/dev/null; then
  echo "origin/main: $(git rev-parse --short origin/main) ($(git log -1 --format=%cd --date=format:%d.%m.%Y_%H:%M origin/main))"
else
  echo "git fetch a EȘUAT (rețea / acces repo)"
fi

hr "PM2"
pm2 list 2>&1 | head -12
echo "pm2 bin: $(command -v pm2 || echo NEGĂSIT)"

hr "HEALTH (localhost:3000)"
curl -s -m 5 localhost:3000/health || echo "NU RĂSPUNDE"
echo

hr "PONTURILE ZILEI (public/daily_picks.json)"
if [ -f public/daily_picks.json ]; then
  ls -l --time-style=long-iso public/daily_picks.json | awk '{print "modificat:", $6, $7}'
  head -c 400 public/daily_picks.json; echo
else
  echo "FIȘIERUL LIPSEȘTE"
fi
echo "--- logs/daily-picks.log (ultimele 3) ---"
tail -3 logs/daily-picks.log 2>/dev/null | cut -c1-200 || echo "(fără log)"

hr "DB (fixtures / predictions)"
if [ -n "${POSTGRES_URL:-}" ]; then
  psql "$POSTGRES_URL" -At -F ' : ' -c "
    select 'fixtures urmatoarele 48h', count(*)::text from fixtures where match_date >= now() and match_date < now() + interval '48 hours'
    union all select 'predictions urmatoarele 24h', count(*)::text from predictions where match_date >= now() and match_date < now() + interval '24 hours'
    union all select 'ultim meci in fixtures_history', max(match_date)::text from fixtures_history
    union all select 'ultima predictie (match_date)', max(match_date)::text from predictions;" 2>&1
else
  echo "POSTGRES_URL lipsește din .env"
fi

hr "TEST DIRECT: ponturi + calendar (ce vede aplicația)"
echo "GET /daily_picks.json -> HTTP $(curl -s -o /tmp/dp.json -w '%{http_code}' -m 8 localhost:3000/daily_picks.json) | $(head -c 160 /tmp/dp.json)"
for d in "$(date +%F)" "$(date -d '+1 day' +%F)" "$(date -d '-1 day' +%F)"; do
  curl -s -m 15 "localhost:3000/api/matches-history?date=$d" -o /tmp/mh.json -w "calendar $d -> HTTP %{http_code} | " ; python3 -c "import json;d=json.load(open('/tmp/mh.json'));g=d.get('groups',[]);print('ok=',d.get('ok'),'ligi=',len(g),'meciuri=',sum(len(x.get('matches',[])) for x in g),'err=',d.get('error'))" 2>&1 | cut -c1-160
done

hr "DE CE E GOALĂ BANDA (diag_picks, primele 30 linii)"
python3 ml/diag_picks.py 2>&1 | head -30 | cut -c1-180

hr "CRON"
echo "linii active în crontab: $(crontab -l 2>/dev/null | grep -vcE '^\s*#|^\s*$')"
crontab -l 2>/dev/null | grep -E 'daily_picks|auto-predict|collect-daily|auto-deploy|watchdog' | cut -c1-110
echo "--- logs/cron.log (ultimele 5) ---"
tail -c 600 logs/cron.log 2>/dev/null | cut -c1-300; echo; echo "(cron.log modificat: $(stat -c %y logs/cron.log 2>/dev/null | cut -c1-19))"
echo "--- logs/auto-deploy.log (ultimele 5) ---"
tail -5 logs/auto-deploy.log 2>/dev/null | cut -c1-200 || echo "(fără log)"

hr "SSH (setări relevante pentru GitHub Actions)"
sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|pubkeyauthentication) ' || echo "(nu pot citi sshd -T)"
echo "IP public: $(curl -s -m 5 ifconfig.me || echo necunoscut)"

hr "RESURSE"
df -h / | tail -1
free -m | head -2

hr "ULTIMELE ERORI PM2"
pm2 logs alohascan --nostream --lines 12 --err 2>&1 | tail -16 | cut -c1-200
echo
echo "Doctor complet: $(date)"
