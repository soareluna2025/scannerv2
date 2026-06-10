"""
backfill-stats-api.py — completează prin API-Football statisticile de meci
(match_stats) și arbitrul (fixtures_history.referee) pentru fixturile istorice
care le au lipsă. SINGURUL script care folosește API (cotă mare, țintit).

Scrie în ACELEAȘI tabele/format ca api/cron/collect-finished.js (match_stats:
aceleași 19 coloane + mapare type→coloană; referee din /fixtures). Astfel datele
sunt citite natural de build-ml-features, antrenarea pre-meci (cards/corners),
backfill-referee-stats și train_live_v2.

Cerințe respectate: --limit N, --since YYYY, cele mai RECENTE întâi, progres la
100, reluabil (skip ce există), retry 429 (30s/60s) ca fetch-api.js, throttle.

Rulare:  python3 scripts/backfill-stats-api.py --limit 1500 --since 2023
"""
import os
import sys
import json
import time
import urllib.request
import urllib.error
import psycopg2

BASE = "https://v3.football.api-sports.io"


def _load_env(path="/root/scannerv2/.env"):
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip(); v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass


def get_conn():
    _load_env()
    url = os.getenv("POSTGRES_URL")
    if url:
        return psycopg2.connect(url)
    return psycopg2.connect(
        dbname=os.getenv("PGDATABASE", "elefant"), user=os.getenv("PGUSER", "alohascan"),
        password=os.getenv("PGPASSWORD"), host=os.getenv("PGHOST", "127.0.0.1"),
        port=os.getenv("PGPORT", "5432"))


def api_key():
    return (os.getenv("API_FOOTBALL_KEY") or os.getenv("FOOTBALL_API_KEY")
            or os.getenv("APIFOOTBALL_KEY") or "")


def api_get(path):
    """GET API-Football cu retry 429 (30s/60s) + 5s pe alte erori — ca fetch-api.js."""
    url = path if path.startswith("http") else BASE + path
    headers = {"x-apisports-key": api_key()}
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 30 if attempt == 0 else 60
                print(f"  [429] aștept {wait}s — {url}")
                time.sleep(wait); continue
            if attempt == 2:
                print(f"  [HTTP {e.code}] {url}"); return None
            time.sleep(5)
        except Exception as e:
            if attempt == 2:
                print(f"  [ERR] {e} — {url}"); return None
            time.sleep(5)
    return None


def _pi(v):
    try:
        return int(float(str(v).replace("%", "").strip()))
    except Exception:
        return 0


def _pf(v):
    try:
        return float(str(v).replace("%", "").strip())
    except Exception:
        return None


MS_SQL = """
INSERT INTO match_stats
  (fixture_id, team_id, team_name, shots_on_goal, shots_total, blocked_shots,
   shots_insidebox, shots_outsidebox, expected_goals, ball_possession,
   total_passes, passes_accurate, pass_percentage, fouls, yellow_cards,
   red_cards, corner_kicks, offsides, goalkeeper_saves)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (fixture_id, team_id) DO UPDATE SET
  team_name=EXCLUDED.team_name, shots_on_goal=EXCLUDED.shots_on_goal,
  shots_total=EXCLUDED.shots_total, blocked_shots=EXCLUDED.blocked_shots,
  shots_insidebox=EXCLUDED.shots_insidebox, shots_outsidebox=EXCLUDED.shots_outsidebox,
  expected_goals=EXCLUDED.expected_goals, ball_possession=EXCLUDED.ball_possession,
  total_passes=EXCLUDED.total_passes, passes_accurate=EXCLUDED.passes_accurate,
  pass_percentage=EXCLUDED.pass_percentage, fouls=EXCLUDED.fouls,
  yellow_cards=EXCLUDED.yellow_cards, red_cards=EXCLUDED.red_cards,
  corner_kicks=EXCLUDED.corner_kicks, offsides=EXCLUDED.offsides,
  goalkeeper_saves=EXCLUDED.goalkeeper_saves
"""


def upsert_stats(cur, fixture_id, resp):
    n = 0
    for team_stat in (resp or []):
        s = {e["type"]: e["value"] for e in team_stat.get("statistics", [])}
        team = team_stat.get("team", {})
        cur.execute(MS_SQL, (
            fixture_id, team.get("id"), team.get("name"),
            _pi(s.get("Shots on Goal")), _pi(s.get("Total Shots")), _pi(s.get("Blocked Shots")),
            _pi(s.get("Shots insidebox")), _pi(s.get("Shots outsidebox")),
            _pf(s.get("expected_goals")), _pf(s.get("Ball Possession")),
            _pi(s.get("Total passes")), _pi(s.get("Passes accurate")), _pf(s.get("Passes %")),
            _pi(s.get("Fouls")), _pi(s.get("Yellow Cards")), _pi(s.get("Red Cards")),
            _pi(s.get("Corner Kicks")), _pi(s.get("Offsides")), _pi(s.get("Goalkeeper Saves")),
        ))
        n += 1
    return n


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    limit = int(arg("--limit", "1500"))
    since = f"{arg('--since', '2023')}-01-01"
    throttle = float(arg("--sleep", "0.2"))
    if not api_key():
        print("⚠ API_FOOTBALL_KEY lipsă din .env — abort."); return

    conn = get_conn(); conn.autocommit = False
    cur = conn.cursor()
    cur.execute("""
        SELECT fh.fixture_id, fh.home_team_id,
               (NOT EXISTS (SELECT 1 FROM match_stats ms WHERE ms.fixture_id=fh.fixture_id)) AS need_stats,
               (fh.referee IS NULL OR btrim(fh.referee)='') AS need_ref
          FROM fixtures_history fh
         WHERE fh.match_date >= %s AND fh.status_short='FT'
           AND (NOT EXISTS (SELECT 1 FROM match_stats ms WHERE ms.fixture_id=fh.fixture_id)
                OR fh.referee IS NULL OR btrim(fh.referee)='')
         ORDER BY fh.match_date DESC
         LIMIT %s
    """, (since, limit))
    targets = cur.fetchall()
    print(f"Fixturi de completat: {len(targets)}  (cele mai recente întâi, since={since})")

    calls = 0; stats_done = 0; ref_done = 0
    for i, (fid, hid, need_stats, need_ref) in enumerate(targets, 1):
        if need_stats:
            data = api_get(f"/fixtures/statistics?fixture={fid}"); calls += 1
            if data and data.get("response"):
                try:
                    if upsert_stats(cur, fid, data["response"]) > 0:
                        stats_done += 1
                except Exception as e:
                    print(f"  [db stats {fid}] {e}")
            time.sleep(throttle)
        if need_ref:
            data = api_get(f"/fixtures?id={fid}"); calls += 1
            try:
                ref = (data["response"][0]["fixture"]["referee"]
                       if data and data.get("response") else None)
                if ref:
                    cur.execute("UPDATE fixtures_history SET referee=%s WHERE fixture_id=%s",
                                (ref, fid)); ref_done += 1
            except Exception as e:
                print(f"  [db ref {fid}] {e}")
            time.sleep(throttle)
        if i % 100 == 0:
            conn.commit()
            print(f"  [{i}/{len(targets)}] calls={calls} stats+={stats_done} ref+={ref_done}")
    conn.commit()
    print(f"✅ API backfill: {len(targets)} fixturi · {calls} apeluri API · "
          f"stats={stats_done} · referee={ref_done}")
    cur.close(); conn.close()


if __name__ == "__main__":
    main()
