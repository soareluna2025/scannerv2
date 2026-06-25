// scripts/shadow-neutral.js — SHADOW read-only pentru fix-ul de teren neutru.
//
// Rulează logica REALĂ de lambda din api/enrich.js (calcPoisson + helperele de
// formă/ligă/H2H, importate, NU duplicate) pe fixture-ul Ecuador (home) vs
// Germany (away) din World Cup (league_id=1), de DOUĂ ori:
//   BEFORE = path-ul de PRODUCȚIE (flag OFF): formă venue-split + homeAdvantage 1.25
//   AFTER  = path-ul NEUTRU  (flag ON): formă generală + homeAdvantage 1.0
//
// Cum reproducem ambele config-uri într-un singur proces: setăm
// process.env.NEUTRAL_VENUE_FIX='1' ÎNAINTE de import (deci constanta din modul e
// ON), apoi controlăm exact ca handler-ul: ce formă dăm + ce valoare `neutral`
// pasăm la calcPoisson. Cu neutral=false, gate-ul (FLAG && neutral) e false →
// homeAdvantage 1.25 → IDENTIC cu producția (flag OFF).
//
// READ-ONLY: doar SELECT-uri. NU scrie nimic, NU rulează cron, NU atinge alt
// fixture. NU compară decât motorul de bază (calcPoisson) — lanțul de ajustări
// downstream (top-scorer, accidentări, ELO, weights) e IDENTIC pe ambele rulări
// (nu e gated pe neutral), deci nu afectează delta atribuită fix-ului.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --- 1) Încarcă .env (db.js citește POSTGRES_URL la import) ÎNAINTE de orice import dinamic ---
const __dir = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dir, '..', '.env');
try {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
} catch (e) {
  console.error(`[shadow] Nu am putut citi ${ENV_PATH}: ${e.message}`);
  process.exit(1);
}

// Forțăm flag-ul ON DOAR în acest proces de shadow (nu atinge .env / producția).
process.env.NEUTRAL_VENUE_FIX = '1';

// --- 2) Import dinamic DUPĂ ce env e setat (altfel Pool-ul se naște fără POSTGRES_URL) ---
const dbMod = await import('../api/db.js');
const query = dbMod.query;
const pool  = dbMod.default;
const {
  calcPoisson, getLeagueStats, getHomeForm, getAwayForm,
  getRecentForm, getH2HFromDB, h2hToFixtures, isNeutralVenue,
} = await import('../api/enrich.js');

const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const goalsAvg = (games, teamId) => {
  if (!games.length) return null;
  const gf = games.reduce((s, m) => s + ((m.teams?.home?.id === teamId ? m.goals?.home : m.goals?.away) ?? 0), 0);
  return Math.round((gf / games.length) * 100) / 100;
};

async function main() {
  const LGID = 1; // World Cup (confirmat în api/worldcup.js)

  // --- 3) Fixture Ecuador (home) vs Germany (away) din World Cup ---
  const { rows } = await query(
    `SELECT fixture_id, home_team_id, away_team_id, home_team_name, away_team_name,
            league_id, match_date, status_short
       FROM fixtures
      WHERE league_id = $1
        AND home_team_name ILIKE '%ecuador%'
        AND away_team_name ILIKE '%germany%'
      ORDER BY match_date DESC
      LIMIT 1`,
    [LGID]
  );

  if (!rows.length) {
    console.error('[shadow] Nu am găsit Ecuador(home) vs Germany(away) în league_id=1.');
    const { rows: cand } = await query(
      `SELECT fixture_id, home_team_name, away_team_name, league_id, match_date
         FROM fixtures
        WHERE (home_team_name ILIKE '%ecuador%' OR away_team_name ILIKE '%ecuador%')
          AND (home_team_name ILIKE '%germany%' OR away_team_name ILIKE '%germany%')
        ORDER BY match_date DESC LIMIT 5`
    );
    if (cand.length) {
      console.error('[shadow] Candidați apropiați (orice ligă/sens):');
      for (const c of cand) console.error(`  fid=${c.fixture_id}  ${c.home_team_name} vs ${c.away_team_name}  lg=${c.league_id}  ${new Date(c.match_date).toISOString().slice(0,10)}`);
    }
    return;
  }

  const fx = rows[0];
  const hId = Number(fx.home_team_id);
  const aId = Number(fx.away_team_id);
  console.log('================================================================');
  console.log(`Fixture: ${fx.home_team_name} (home) vs ${fx.away_team_name} (away)`);
  console.log(`fixture_id=${fx.fixture_id}  league_id=${fx.league_id}  status=${fx.status_short}  date=${new Date(fx.match_date).toISOString().slice(0,10)}`);
  console.log(`isNeutralVenue(league_id=${fx.league_id}) = ${isNeutralVenue(fx.league_id)}  ·  POISSON_RHO=${process.env.POISSON_RHO || '(default -0.13)'}`);
  console.log('================================================================\n');

  // --- 4) Glue identic cu handler-ul (același pentru ambele rulări) ---
  const leagueStats = await getLeagueStats(LGID);
  const lgHome = parseFloat(leagueStats?.avg_home_goals) || 1.2;
  const lgAway = parseFloat(leagueStats?.avg_away_goals) || 1.2;
  const sbH2H  = await getH2HFromDB(hId, aId);
  const h2h    = h2hToFixtures(sbH2H);

  // BEFORE: formă venue-split (cum o ia handler-ul cu flag OFF)
  const beforeH = await getHomeForm(hId);
  const beforeA = await getAwayForm(aId);
  // AFTER: formă generală (getRecentForm, cum o ia handler-ul cu flag ON pe neutru)
  const afterH  = await getRecentForm(hId);
  const afterA  = await getRecentForm(aId);

  // --- 5) Aceeași funcție REALĂ calcPoisson, doar `neutral` + sursa de formă diferă ---
  // elapsed/hg/ag/soth/sota = undefined → pre-meci (fără lambda dinamic).
  const before = calcPoisson(beforeH, beforeA, h2h, hId, aId, undefined, undefined, undefined, undefined, undefined, lgHome, lgAway, leagueStats, false);
  const after  = calcPoisson(afterH,  afterA,  h2h, hId, aId, undefined, undefined, undefined, undefined, undefined, lgHome, lgAway, leagueStats, true);

  // --- 6) Tabel comparativ ---
  const pad = (s, n) => String(s).padEnd(n);
  const row = (label, b, a) => console.log(pad(label, 18) + '│ ' + pad(b, 22) + '│ ' + a);
  console.log(pad('', 18) + '│ ' + pad('BEFORE (flag OFF/prod)', 22) + '│ AFTER (flag ON/neutru)');
  console.log('─'.repeat(18) + '┼' + '─'.repeat(23) + '┼' + '─'.repeat(24));
  row('formă folosită', 'venue-split', 'generală (recent)');
  row('  home: nr me.', `${beforeH.length} (gf~${goalsAvg(beforeH,hId)})`, `${afterH.length} (gf~${goalsAvg(afterH,hId)})`);
  row('  away: nr me.', `${beforeA.length} (gf~${goalsAvg(beforeA,aId)})`, `${afterA.length} (gf~${goalsAvg(afterA,aId)})`);
  row('homeAdvantage', '1.25', '1.0');
  console.log('─'.repeat(18) + '┼' + '─'.repeat(23) + '┼' + '─'.repeat(24));
  row('lambda_home',  r2(before.lambdaHome), r2(after.lambdaHome));
  row('lambda_away',  r2(before.lambdaAway), r2(after.lambdaAway));
  row('home_win_prob', before.homeWin + '%', after.homeWin + '%');
  row('draw_prob',     before.draw    + '%', after.draw    + '%');
  row('away_win_prob', before.awayWin + '%', after.awayWin + '%');
  console.log('\n[shadow] Notă: calcPoisson = motorul de bază (acolo trăiește fix-ul).');
  console.log('[shadow] Ajustările downstream (top-scorer/accidentări/ELO/weights) sunt');
  console.log('[shadow] identice pe ambele rulări → nu afectează delta neutru vs prod.');
}

main()
  .catch((e) => { console.error('[shadow] EROARE:', e && e.stack ? e.stack : e); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch (_) {} });
