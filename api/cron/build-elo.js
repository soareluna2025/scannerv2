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

// Multiplicator de importanță a competiției aplicat peste K (meciuri „grele"
// mișcă ELO mai mult). Default 1.0 pt ligi normale.
function getCompetitionWeight(leagueId) {
  // UCL, UEL, UECL
  if ([2, 3, 848].includes(leagueId)) return 1.5;
  // Cupe Mondiale + Calificări CM + Nations League
  if ([1, 5, 6, 29, 30, 31, 32, 33, 34].includes(leagueId)) return 1.5;
  // Ligi principale majore (top 10 europene)
  if ([39, 140, 135, 78, 61, 88, 94, 203, 207, 197].includes(leagueId)) return 1.3;
  // Copa Libertadores, Copa Sudamericana
  if ([13, 11].includes(leagueId)) return 1.3;
  // Cupe naționale principale
  if ([45, 143, 137, 81, 65].includes(leagueId)) return 0.8;
  // Ligi secundare
  if ([40, 141, 136, 79, 62].includes(leagueId)) return 0.9;
  // Amicale
  if ([10].includes(leagueId)) return 0.5;
  // Default — ligi normale
  return 1.0;
}

async function ensureTables() {
  await query(`CREATE TABLE IF NOT EXISTS elo_ratings (
    team_id INTEGER NOT NULL, league_id INTEGER NOT NULL,
    elo NUMERIC(8,2) DEFAULT 1500, games INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (team_id, league_id))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_elo_team   ON elo_ratings(team_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_elo_league ON elo_ratings(league_id)`);
  await query(`CREATE TABLE IF NOT EXISTS elo_applied (fixture_id INTEGER PRIMARY KEY)`);
  await query(`CREATE TABLE IF NOT EXISTS elo_history (
    fixture_id INTEGER NOT NULL, home_team_id INTEGER NOT NULL, away_team_id INTEGER NOT NULL,
    home_elo NUMERIC(8,2) NOT NULL, away_elo NUMERIC(8,2) NOT NULL,
    elo_diff NUMERIC(8,2) NOT NULL, home_win_prob NUMERIC(5,4) NOT NULL,
    PRIMARY KEY (fixture_id))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_elo_history_fixture ON elo_history(fixture_id)`);
}

async function logCron(status, msg = '') {
  try { await Promise.resolve(/* cron_logs → dispecer */); } catch (_) {}
}

export default async function handler(req, res) {
  try {
    await ensureTables();
    // Reconstrucție curată: golim guard-ul de idempotență ca să permitem
    // re-procesarea completă cu noul K (ponderat pe competiție). Se repopulează
    // la final cu setul replay-at.
    await query(`DELETE FROM elo_applied`).catch(() => {});

    const { rows } = await query(`
      SELECT fixture_id, league_id, home_team_id, away_team_id, home_goals, away_goals, match_date
      FROM fixtures_history
      WHERE status_short = ANY($1)
        AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
        AND home_goals IS NOT NULL  AND away_goals IS NOT NULL
        AND league_id = ANY($2)
      ORDER BY match_date ASC NULLS LAST, fixture_id ASC
    `, [DONE, ALLOWED]);

    // ── Rolling Window 100: include în replay doar ultimele 100 meciuri per echipă.
    // Parcurgere cronologică DESC; un meci e inclus dacă e în top-100 al gazdei SAU
    // al oaspetelui. Echipele cu <100 meciuri își păstrează toate meciurile.
    const teamCount = new Map();   // team_id → câte meciuri i-am inclus deja
    const included = new Set();    // fixture_id incluse în replay
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i];
      const hc = teamCount.get(m.home_team_id) || 0;
      const ac = teamCount.get(m.away_team_id) || 0;
      let keep = false;
      if (hc < 100) { teamCount.set(m.home_team_id, hc + 1); keep = true; }
      if (ac < 100) { teamCount.set(m.away_team_id, ac + 1); keep = true; }
      if (keep) included.add(m.fixture_id);
    }
    const NOW_TS = Date.now();
    let matchesUsed = 0;

    // ELO per (team_id, league_id) — conform PK. Replay cronologic din 1500.
    const teamElo = new Map();
    const getT = (tid, lid) => {
      const k = tid + '|' + lid;
      let t = teamElo.get(k);
      if (!t) { t = { elo: 1500, games: 0, team_id: tid, league_id: lid }; teamElo.set(k, t); }
      return t;
    };

    // Buffer pt elo_history (snapshot PRE-MECI) — bulk insert la fiecare 1000.
    const histBuf = [];
    const HIST_CH = 1000;
    async function flushHist() {
      if (!histBuf.length) return;
      const vals = [], params = [];
      histBuf.forEach((r, i) => {
        const b = i * 7;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`);
        params.push(r.fid, r.hid, r.aid, r.he, r.ae, r.diff, r.hwp);
      });
      await query(`INSERT INTO elo_history
          (fixture_id, home_team_id, away_team_id, home_elo, away_elo, elo_diff, home_win_prob)
        VALUES ${vals.join(',')}
        ON CONFLICT (fixture_id) DO UPDATE SET
          home_elo=EXCLUDED.home_elo, away_elo=EXCLUDED.away_elo,
          elo_diff=EXCLUDED.elo_diff, home_win_prob=EXCLUDED.home_win_prob`, params);
      histBuf.length = 0;
    }

    for (const m of rows) {
      if (!included.has(m.fixture_id)) continue;   // Rolling window 100
      matchesUsed++;
      const lid = m.league_id;
      const H = getT(m.home_team_id, lid), A = getT(m.away_team_id, lid);
      // Snapshot PRE-MECI (ELO-ul de DINAINTEA meciului — fără lookahead).
      const preH = H.elo, preA = A.elo;
      const expH = 1 / (1 + Math.pow(10, (preA - preH) / 400));  // = home_win_prob
      histBuf.push({
        fid: m.fixture_id, hid: m.home_team_id, aid: m.away_team_id,
        he: +preH.toFixed(2), ae: +preA.toFixed(2),
        diff: +(preH - preA).toFixed(2), hwp: +expH.toFixed(4),
      });
      if (histBuf.length >= HIST_CH) await flushHist();
      // ABIA DUPĂ snapshot → actualizează ELO cu rezultatul meciului.
      // K = K_bază (după nr. meciuri) × greutatea competiției × temporal decay.
      const hg = Number(m.home_goals), ag = Number(m.away_goals);
      const actH = hg > ag ? 1 : hg === ag ? 0.5 : 0;
      const weight = getCompetitionWeight(lid);
      // Temporal decay: meciurile vechi mișcă ELO mai puțin (phi=0.03/lună).
      let decayFactor = 1;
      if (m.match_date) {
        const monthsAgo = (NOW_TS - new Date(m.match_date).getTime()) / (1000 * 60 * 60 * 24 * 30);
        if (Number.isFinite(monthsAgo)) decayFactor = Math.exp(-0.03 * Math.max(0, monthsAgo));
      }
      const kH = kFactor(H.games) * weight * decayFactor;
      const kA = kFactor(A.games) * weight * decayFactor;
      H.elo += kH * (actH - expH);
      A.elo += kA * ((1 - actH) - (1 - expH));
      H.games++; A.games++;
    }
    await flushHist();  // restul buffer-ului

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

    await logCron('success', `teams:${upserts} used:${matchesUsed}/${rows.length}`);
    return res.status(200).json({
      ok: true,
      teams: upserts,
      matches_total: rows.length,
      matches_used: matchesUsed,
      elo_history_rows: matchesUsed,
      note: 'Temporal decay phi=0.03/lună + Rolling window 100',
    });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
