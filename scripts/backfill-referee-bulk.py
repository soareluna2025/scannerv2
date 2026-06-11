"""
backfill-referee-bulk.py — umple fixtures_history.referee EFICIENT: UN apel
API-Football per (league_id, season) aduce TOT sezonul (fixtures?league=X&season=Y),
din care extragem fixture.referee. ~1.400 apeluri în loc de ~350k per-fixture.

Reguli: actualizează DOAR `referee` și DOAR unde e NULL (nu suprascrie). Nu atinge
alte coloane / scoring / enrich. Reluabil (bulk_referee_checked). Memory-safe
(procesare per pereche). Retry 429 + throttle ca backfill-stats-api.py.

Rulare:  python3 scripts/backfill-referee-bulk.py --limit 200 [--dry-run]
"""
import os
import sys
import json
import time
import urllib.request
import urllib.error
import psycopg2
from psycopg2.extras import execute_values

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
    """GET cu retry 429 (30s/60s) + 5s pe alte erori — ca fetch-api.js."""
    url = path if path.startswith("http") else BASE + path
    headers = {"x-apisports-key": api_key()}
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 30 if attempt == 0 else 60
                print(f"  [429] aștept {wait}s — {url}"); time.sleep(wait); continue
            if attempt == 2:
                print(f"  [HTTP {e.code}] {url}"); return None
            time.sleep(5)
        except Exception as e:
            if attempt == 2:
                print(f"  [ERR] {e} — {url}"); return None
            time.sleep(5)
    return None


CREATE_CHECKED = """
CREATE TABLE IF NOT EXISTS bulk_referee_checked (
    league_id     INTEGER NOT NULL,
    season        INTEGER NOT NULL,
    checked_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_count INTEGER DEFAULT 0,
    PRIMARY KEY (league_id, season)
);
"""

# Perechi (league_id, season) care AU meciuri cu referee NULL și NU-s deja procesate.
PAIRS_SQL = """
SELECT fh.league_id, fh.season, COUNT(*) AS missing
  FROM fixtures_history fh
 WHERE fh.league_id IS NOT NULL AND fh.season IS NOT NULL
   AND (fh.referee IS NULL OR btrim(fh.referee)='')
   AND NOT EXISTS (SELECT 1 FROM bulk_referee_checked c
                    WHERE c.league_id=fh.league_id AND c.season=fh.season)
 GROUP BY fh.league_id, fh.season
 ORDER BY fh.season DESC, fh.league_id
 LIMIT %s
"""

# UPDATE în batch (un singur statement) → rowcount fiabil. DOAR unde referee e NULL.
UPDATE_SQL = """
UPDATE fixtures_history fh
   SET referee = d.ref
  FROM (VALUES %s) AS d(fid, ref)
 WHERE fh.fixture_id = d.fid::int
   AND (fh.referee IS NULL OR btrim(fh.referee)='')
"""

MARK_SQL = """
INSERT INTO bulk_referee_checked (league_id, season, checked_at, updated_count)
VALUES (%s, %s, NOW(), %s)
ON CONFLICT (league_id, season) DO UPDATE SET
  checked_at=NOW(), updated_count=EXCLUDED.updated_count
"""


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    limit = int(arg("--limit", "200"))
    throttle = float(arg("--sleep", "0.3"))
    dry = "--dry-run" in sys.argv

    conn = get_conn(); conn.autocommit = False
    cur = conn.cursor()
    cur.execute(CREATE_CHECKED); conn.commit()
    cur.execute(PAIRS_SQL, (limit,))
    pairs = cur.fetchall()
    print(f"Perechi (league_id, season) de procesat: {len(pairs)} "
          f"(recente întâi, limit={limit}){' [DRY-RUN]' if dry else ''}")
    if dry:
        for lg, season, missing in pairs[:50]:
            print(f"  lg={lg} season={season} missing={missing}")
        if len(pairs) > 50:
            print(f"  ... și încă {len(pairs)-50} perechi")
        cur.close(); conn.close(); return

    if not api_key():
        print("⚠ API_FOOTBALL_KEY lipsă din .env — abort."); return

    calls = 0; total_written = 0
    for i, (lg, season, missing) in enumerate(pairs, 1):
        data = api_get(f"/fixtures?league={lg}&season={season}"); calls += 1
        rows = []
        for item in (data.get("response", []) if data else []):
            try:
                fid = item["fixture"]["id"]
                ref = item["fixture"].get("referee")
                if fid and ref and str(ref).strip():
                    rows.append((int(fid), str(ref).strip()))
            except Exception:
                continue
        updated = 0
        if rows:
            try:
                execute_values(cur, UPDATE_SQL, rows, page_size=1000)
                updated = cur.rowcount or 0
            except Exception as e:
                print(f"  [db lg={lg} s={season}] {e}")
                conn.rollback()
        cur.execute(MARK_SQL, (lg, season, updated))
        conn.commit()
        total_written += updated
        print(f"  [{i}/{len(pairs)}] lg={lg} season={season} → actualizate={updated}/{len(rows)} "
              f"(API meciuri={len(data.get('response', [])) if data else 0})")
        time.sleep(throttle)

    cur.execute("SELECT COUNT(*) FROM fixtures_history WHERE referee IS NOT NULL AND btrim(referee)<>''")
    have_ref = cur.fetchone()[0]
    print(f"\n✅ Bulk referee: {len(pairs)} perechi · {calls} apeluri API · "
          f"referee scriși={total_written}")
    print(f"   fixtures_history cu referee acum: {have_ref}")
    cur.close(); conn.close()


if __name__ == "__main__":
    main()
