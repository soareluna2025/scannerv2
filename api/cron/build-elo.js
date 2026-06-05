// Cron: GET /api/cron/build-elo
// Reconstruiește ELO GLOBAL persistat per (echipă, ligă) din fixtures_history,
// cronologic, cu K dinamic. Sursă de adevăr — rulează săptămânal (luni 06:00).
// NEFOLOSIT în scoring: doar calculează și persistă în elo_ratings.
//
// K dinamic: games<10 → 40 ; games<30 → 32 ; altfel → 24.
// Marchează toate fixturile procesate în elo_applied → update-ul incremental
// din collect-finished nu le re-aplică (exactly-once între reconstrucții).

import { query } from '../db.js';
import { ALLOWED_LEAGUE_IDS } from '../leagues.js';

const ALLOWED = [...ALLOWED_LEAGUE_IDS];
const DONE = ['FT', 'AET', 'PEN'];

function kFactor(games) { return games < 10 ? 40 : games < 30 ? 32 : 24; }

async function ensureTables() {
  await query(`CREATE TABLE IF NOT EXISTS elo_ratings (
    team_id INTEGER NOT NULL, league_id INTEGER NOT NULL,
    elo NUMERIC(8,2) DEFAULT 1500, games INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (team_id, league_id))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_elo_team   ON elo_ratings(team_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_elo_league ON elo_ratings(league_id)`);
  await query(`CREATE TABLE IF NOT EXISTS elo_applied (fixture_id INTEGER PRIMARY KEY)`);
}

async function logCron(status, msg = '') {
  try { await query(`INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('build-elo', $1, $2)`, [status, msg || null]); } catch (_) {}
}

export default async function handler(req, res) {
  try {
    await ensureTables();

    const { rows } = await query(`
      SELECT fixture_id, league_id, home_team_id, away_team_id, home_goals, away_goals
      FROM fixtures_history
      WHERE status_short = ANY($1)
        AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
        AND home_goals IS NOT NULL  AND away_goals IS NOT NULL
        AND league_id = ANY($2)
      ORDER BY match_date ASC NULLS LAST, fixture_id ASC
    `, [DONE, ALLOWED]);

    // ELO per (team_id, league_id) — conform PK. Replay cronologic din 1500.
    const teamElo = new Map();
    const getT = (tid, lid) => {
      const k = tid + '|' + lid;
      let t = teamElo.get(k);
      if (!t) { t = { elo: 1500, games: 0, team_id: tid, league_id: lid }; teamElo.set(k, t); }
      return t;
    };

    for (const m of rows) {
      const lid = m.league_id;
      const H = getT(m.home_team_id, lid), A = getT(m.away_team_id, lid);
      const expH = 1 / (1 + Math.pow(10, (A.elo - H.elo) / 400));
      const hg = Number(m.home_goals), ag = Number(m.away_goals);
      const actH = hg > ag ? 1 : hg === ag ? 0.5 : 0;
      H.elo += kFactor(H.games) * (actH - expH);
      A.elo += kFactor(A.games) * ((1 - actH) - (1 - expH));
      H.games++; A.games++;
    }

    // UPSERT toate echipele
    let upserts = 0;
    for (const t of teamElo.values()) {
      await query(`INSERT INTO elo_ratings (team_id, league_id, elo, games, updated_at)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (team_id, league_id) DO UPDATE SET
          elo=EXCLUDED.elo, games=EXCLUDED.games, updated_at=NOW()`,
        [t.team_id, t.league_id, +t.elo.toFixed(2), t.games]);
      upserts++;
    }

    // Marchează fixturile ca aplicate (bulk, în chunks) — incremental le va sări.
    const fids = rows.map(r => r.fixture_id);
    const CH = 1000;
    for (let i = 0; i < fids.length; i += CH) {
      const chunk = fids.slice(i, i + CH);
      const vals = chunk.map((_, j) => '($' + (j + 1) + ')').join(',');
      await query(`INSERT INTO elo_applied (fixture_id) VALUES ${vals} ON CONFLICT DO NOTHING`, chunk);
    }

    await logCron('success', `teams:${upserts} matches:${rows.length}`);
    return res.status(200).json({ ok: true, teams: upserts, matches: rows.length });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
