#!/usr/bin/env node
// Generator Debug — calculează scor + arată toate intermediarele pentru un meci specific
//
// Util pentru debug rapid: vezi exact ce date are generatorul pentru un fixture
// și de ce iese scorul X. Compară cu outcome-ul real dacă meciul s-a terminat.
//
// Rulare pe VPS:
//   node scripts/generator-debug.js --fixture 123456
//   node scripts/generator-debug.js --fixture 123456 --category gg
//   node scripts/generator-debug.js --fixture 123456 --category goals --sub total --thr 1.5

// ── Auto-load .env ────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname_ = dirname(fileURLToPath(import.meta.url));

for (const p of [join(__dirname_, '..', '.env'), '/root/scannerv2/.env', resolve(process.cwd(), '.env')]) {
  if (existsSync(p)) {
    for (let line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      line = line.replace(/^\s*export\s+/, '');
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) continue;
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
    break;
  }
}

if (!process.env.POSTGRES_URL) { console.error('❌ POSTGRES_URL lipseste'); process.exit(1); }

import pkg from 'pg';
const { Pool } = pkg;
const url = new URL(process.env.POSTGRES_URL);
const pool = new Pool({
  host: url.hostname, port: parseInt(url.port) || 5432,
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
});
const query = (t, p) => pool.query(t, p);

// ── Args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const fixtureId = parseInt(argVal('fixture') || '0', 10);
const onlyCat = argVal('category');
const onlySub = argVal('sub');
const onlyThr = argVal('thr') ? parseFloat(argVal('thr')) : null;

if (!fixtureId) {
  console.error('Usage: node scripts/generator-debug.js --fixture <ID> [--category gg] [--sub total] [--thr 1.5]');
  console.error('Categorii disponibile: home, away, gg, goals, cards, corners');
  process.exit(1);
}

// ── Helpers (mirror g2Score) ──────────────────────────────────
function g2Poi(lam, k) { if (lam <= 0) return k === 0 ? 1 : 0; let p = Math.exp(-lam); for (let i = 0; i < k; i++) p = p * lam / (i + 1); return p; }
function g2Over(lam, thr) { const need = Math.floor(thr) + 1; let fail = 0; for (let k = 0; k < need; k++) fail += g2Poi(lam, k); return Math.max(0, Math.min(100, (1 - fail) * 100)); }

function calibrate(cat, sub, thr, raw) {
  const TABLES = {
    home: [[0,20,5],[20,30,5],[30,40,8],[40,50,26],[50,60,58],[60,70,78],[70,80,81],[80,90,96],[90,101,100]],
    away: [[0,30,15],[30,40,16],[40,50,43],[50,60,58],[60,70,70],[70,80,77],[80,90,87],[90,101,100]],
    gg: [[0,20,5],[20,30,5],[30,40,22],[40,50,40],[50,60,54],[60,70,61],[70,80,80],[80,101,70]],
    'goals_total_0.5':[[0,50,30],[50,60,40],[60,70,52],[70,80,81],[80,90,90],[90,101,87]],
    'goals_total_1.5':[[0,30,10],[30,40,15],[40,50,49],[50,60,64],[60,70,73],[70,80,81],[80,90,95],[90,101,100]],
    'goals_total_2.5':[[0,30,18],[30,40,29],[40,50,40],[50,60,61],[60,70,76],[70,80,73],[80,90,89],[90,101,87]],
    'goals_home_0.5':[[0,40,5],[40,50,8],[50,60,27],[60,70,58],[70,80,75],[80,90,81],[90,101,96]],
    'goals_away_0.5':[[0,30,10],[30,40,10],[40,50,10],[50,60,42],[60,70,57],[70,80,70],[80,90,75],[90,101,87]],
  };
  let key;
  if (cat === 'home' || cat === 'away' || cat === 'gg') key = cat;
  else if (cat === 'goals') key = `goals_${sub || 'total'}_${thr || 0.5}`;
  else return raw;
  const tbl = TABLES[key];
  if (!tbl) return raw;
  for (const b of tbl) if (raw >= b[0] && raw < b[1]) return b[2];
  return raw;
}

function g2Score(m, cat, sub, thr) {
  const lg = m.league || { avg_goals: 2.5, pct_over_15: 60, pct_over_25: 40, pct_gg: 50, avg_yellow: 3.5, avg_corners: 9 };
  const ref = m.ref_stats, h2h = m.h2h, fm = m.form || {};
  const fHs = fm.home_avg_scored, fHc = fm.home_avg_conceded, fAs = fm.away_avg_scored, fAc = fm.away_avg_conceded;
  const defLgH = lg.avg_goals * 0.55, defLgA = lg.avg_goals * 0.45;
  const lamH = (fHs != null && fAc != null) ? ((fHs + fAc) / 2) : (fHs != null ? fHs : (fAc != null ? fAc : defLgH));
  const lamA = (fAs != null && fHc != null) ? ((fAs + fHc) / 2) : (fAs != null ? fAs : (fHc != null ? fHc : defLgA));

  let s = 0;
  const intermediates = { lamH: +lamH.toFixed(2), lamA: +lamA.toFixed(2) };

  if (cat === 'home' || cat === 'away') {
    const isH = (cat === 'home'); const lam = isH ? lamH : lamA;
    const poisS = g2Over(lam, 0.5);
    const h2hS = isH ? (h2h ? h2h.pct_home_scores : lg.pct_gg) : (h2h ? h2h.pct_away_scores : lg.pct_gg);
    const lgS = lg.pct_gg;
    s = poisS * 0.40 + h2hS * 0.25 + lgS * 0.20 + poisS * 0.15;
    Object.assign(intermediates, { poisS: +poisS.toFixed(1), h2hS: +(+h2hS).toFixed(1), lgS: +(+lgS).toFixed(1), formula: `${poisS.toFixed(1)}×0.55 + ${(+h2hS).toFixed(1)}×0.25 + ${(+lgS).toFixed(1)}×0.20 = ${s.toFixed(1)}` });
  } else if (cat === 'goals') {
    const isT = (!sub || sub === 'total'), isHG = (sub === 'home');
    const lamG = isT ? (lamH + lamA) : (isHG ? lamH : lamA);
    const poisG = g2Over(lamG, thr);
    const lgPct = thr <= 1 ? lg.pct_over_15 : lg.pct_over_25;
    const h2hPct = thr <= 1 ? (h2h ? +(h2h.pct_over_15) : lgPct) : (h2h ? +(h2h.pct_over_25) : lgPct);
    const refG = ref ? g2Over(ref.avg_goals * (isT ? 1 : 0.5), thr) : poisG;
    s = poisG * 0.35 + lgPct * 0.20 + h2hPct * 0.25 + refG * 0.20;
    Object.assign(intermediates, { lamG: +lamG.toFixed(2), poisG: +poisG.toFixed(1), lgPct: +(+lgPct).toFixed(1), h2hPct: +(+h2hPct).toFixed(1), refG: +refG.toFixed(1), formula: `Poisson(${lamG.toFixed(2)}, ${thr})=${poisG.toFixed(1)} × 0.35 + lgPct(${lgPct.toFixed(1)}) × 0.20 + h2hPct(${h2hPct.toFixed(1)}) × 0.25 + refG(${refG.toFixed(1)}) × 0.20 = ${s.toFixed(1)}` });
  } else if (cat === 'gg') {
    const pHs = g2Over(lamH, 0.5); const pAs = g2Over(lamA, 0.5);
    const pHc = fHc != null ? g2Over(fHc, 0.5) : pAs;
    const pAc = fAc != null ? g2Over(fAc, 0.5) : pHs;
    const compH = (pHs / 100) * (pAc / 100) * 100;
    const compA = (pAs / 100) * (pHc / 100) * 100;
    const h2hGG = h2h ? +(h2h.pct_gg) : lg.pct_gg;
    s = compH * 0.35 + compA * 0.35 + h2hGG * 0.30;
    Object.assign(intermediates, { pHs: +pHs.toFixed(1), pAs: +pAs.toFixed(1), pHc: +pHc.toFixed(1), pAc: +pAc.toFixed(1), compH: +compH.toFixed(1), compA: +compA.toFixed(1), h2hGG: +(+h2hGG).toFixed(1), formula: `compH(${compH.toFixed(1)}) × 0.35 + compA(${compA.toFixed(1)}) × 0.35 + h2hGG(${(+h2hGG).toFixed(1)}) × 0.30 = ${s.toFixed(1)}` });
  }

  const raw = Math.round(Math.max(0, Math.min(100, s)));
  return { raw, calibrated: calibrate(cat, sub, thr, raw), intermediates };
}

// ── Main ──
async function main() {
  console.log(`\n🔬 Generator Debug — fixture #${fixtureId}\n`);

  // Load fixture from history sau fixtures table
  let { rows: [fh] } = await query(`
    SELECT fixture_id, league_id, home_team_id, away_team_id,
           home_team_name, away_team_name, home_goals, away_goals,
           status_short, match_date
    FROM fixtures_history WHERE fixture_id = $1
  `, [fixtureId]);

  let fromHistory = !!fh;
  if (!fh) {
    const { rows: [fx] } = await query(`
      SELECT fixture_id, league_id, home_team_id, away_team_id,
             home_team_name, away_team_name, status_short, match_date
      FROM fixtures WHERE fixture_id = $1
    `, [fixtureId]);
    if (!fx) { console.error(`❌ Fixture #${fixtureId} negăsit nici în fixtures, nici în fixtures_history.`); await pool.end(); process.exit(1); }
    fh = { ...fx, home_goals: null, away_goals: null };
  }

  console.log(`📍 ${fh.home_team_name} (#${fh.home_team_id}) vs ${fh.away_team_name} (#${fh.away_team_id})`);
  console.log(`   Liga: ${fh.league_id} | Data: ${fh.match_date ? new Date(fh.match_date).toISOString().slice(0,16) : 'N/A'}`);
  console.log(`   Status: ${fh.status_short || '?'} | Scor: ${fh.home_goals !== null ? `${fh.home_goals}-${fh.away_goals}` : 'TBD'}\n`);

  // Load all data joins (la fel ca generator-backtest.js)
  const [lsRes, fsRes, tsRes, h2hRes] = await Promise.all([
    query('SELECT * FROM league_stats WHERE league_id = $1', [fh.league_id]),
    query('SELECT * FROM form_stats WHERE team_id IN ($1,$2)', [fh.home_team_id, fh.away_team_id]),
    query(`SELECT DISTINCT ON (team_id) team_id, avg_goals_for, avg_goals_against, clean_sheets_home, clean_sheets_away, played_home, played_away FROM teams_stats WHERE team_id IN ($1,$2) ORDER BY team_id, season DESC`, [fh.home_team_id, fh.away_team_id]),
    query(`SELECT COUNT(*) AS total, AVG(home_goals+away_goals)::NUMERIC(4,2) AS avg_goals,
             (100.0*COUNT(*) FILTER (WHERE home_goals+away_goals>=2)/COUNT(*))::NUMERIC(5,2) AS pct_over_15,
             (100.0*COUNT(*) FILTER (WHERE home_goals+away_goals>=3)/COUNT(*))::NUMERIC(5,2) AS pct_over_25,
             (100.0*COUNT(*) FILTER (WHERE home_goals>0 AND away_goals>0)/COUNT(*))::NUMERIC(5,2) AS pct_gg,
             (100.0*COUNT(*) FILTER (WHERE home_goals>0)/COUNT(*))::NUMERIC(5,2) AS pct_home_scores,
             (100.0*COUNT(*) FILTER (WHERE away_goals>0)/COUNT(*))::NUMERIC(5,2) AS pct_away_scores
           FROM h2h WHERE team1_id=$1 AND team2_id=$2`, [Math.min(fh.home_team_id, fh.away_team_id), Math.max(fh.home_team_id, fh.away_team_id)]),
  ]);

  const lg = lsRes.rows[0] || null;
  const hForm = fsRes.rows.find(r => r.team_id === fh.home_team_id && r.league_id === fh.league_id) || null;
  const aForm = fsRes.rows.find(r => r.team_id === fh.away_team_id && r.league_id === fh.league_id) || null;
  const hTS = tsRes.rows.find(r => r.team_id === fh.home_team_id) || null;
  const aTS = tsRes.rows.find(r => r.team_id === fh.away_team_id) || null;
  const h2h = (h2hRes.rows[0] && +h2hRes.rows[0].total > 0) ? h2hRes.rows[0] : null;

  // Build match object
  const m = {
    league: lg ? { avg_goals: +lg.avg_goals_per_match || 2.5, pct_over_15: +lg.pct_over_15 || 60, pct_over_25: +lg.pct_over_25 || 40, pct_gg: +lg.pct_gg || 50, avg_yellow: +lg.avg_yellow_cards || 3.5, avg_corners: +lg.avg_corners || 9 } : null,
    h2h: h2h ? { total: +h2h.total, avg_goals: +h2h.avg_goals, pct_over_15: +h2h.pct_over_15, pct_over_25: +h2h.pct_over_25, pct_gg: +h2h.pct_gg, pct_home_scores: +h2h.pct_home_scores, pct_away_scores: +h2h.pct_away_scores } : null,
    form: {
      home_avg_scored: hForm ? +hForm.avg_scored_home : (hTS ? +hTS.avg_goals_for : null),
      home_avg_conceded: hForm ? +hForm.avg_conceded_home : (hTS ? +hTS.avg_goals_against : null),
      away_avg_scored: aForm ? +aForm.avg_scored_away : (aTS ? +aTS.avg_goals_for : null),
      away_avg_conceded: aForm ? +aForm.avg_conceded_away : (aTS ? +aTS.avg_goals_against : null),
    },
    ref_stats: null,
  };

  console.log('📊 DATE COLECTATE:');
  console.log(`   Liga stats: ${lg ? '✓' : '✗ MISSING'}  ${lg ? `avg_goals=${m.league.avg_goals}, pct_gg=${m.league.pct_gg}%, pct_O15=${m.league.pct_over_15}%, pct_O25=${m.league.pct_over_25}%` : ''}`);
  console.log(`   H2H DB:     ${h2h ? `✓ (${h2h.total} meciuri istorice)` : '✗ niciun meci direct înregistrat'}`);
  console.log(`   Form gazdă: ${hForm ? `✓ form_stats` : (hTS ? `↳ fallback teams_stats` : '✗ MISSING')}`);
  console.log(`   Form oasp:  ${aForm ? `✓ form_stats` : (aTS ? `↳ fallback teams_stats` : '✗ MISSING')}`);
  console.log(`   Form: home_avg_scored=${m.form.home_avg_scored ?? '?'}, home_avg_conceded=${m.form.home_avg_conceded ?? '?'}, away_avg_scored=${m.form.away_avg_scored ?? '?'}, away_avg_conceded=${m.form.away_avg_conceded ?? '?'}\n`);

  // Calcul scoruri pentru toate piețele (sau doar cea specificată)
  const TESTS = [
    { cat: 'home', sub: null, thr: null, label: 'Gazde marchează' },
    { cat: 'away', sub: null, thr: null, label: 'Oaspeți marchează' },
    { cat: 'gg', sub: null, thr: null, label: 'GG (ambele marchează)' },
    { cat: 'goals', sub: 'total', thr: 0.5, label: 'Over 0.5 total' },
    { cat: 'goals', sub: 'total', thr: 1.5, label: 'Over 1.5 total' },
    { cat: 'goals', sub: 'total', thr: 2.5, label: 'Over 2.5 total' },
  ].filter(t => !onlyCat || t.cat === onlyCat).filter(t => !onlySub || t.sub === onlySub).filter(t => onlyThr === null || t.thr === onlyThr);

  console.log('🧮 SCORURI:');
  console.log('   Piață'.padEnd(28) + '| Brut | Calibrat | Outcome real');
  console.log('   ' + '─'.repeat(60));
  for (const t of TESTS) {
    const r = g2Score(m, t.cat, t.sub, t.thr);
    let outcome = '?';
    if (fh.home_goals !== null) {
      const hg = fh.home_goals, ag = fh.away_goals;
      if (t.cat === 'home') outcome = hg > 0 ? '✓ HIT' : '✗ MISS';
      else if (t.cat === 'away') outcome = ag > 0 ? '✓ HIT' : '✗ MISS';
      else if (t.cat === 'gg') outcome = (hg > 0 && ag > 0) ? '✓ HIT' : '✗ MISS';
      else if (t.cat === 'goals') {
        const tot = t.sub === 'home' ? hg : t.sub === 'away' ? ag : (hg + ag);
        outcome = tot > t.thr ? '✓ HIT' : '✗ MISS';
      }
    }
    console.log('   ' + t.label.padEnd(28) + `| ${String(r.raw).padStart(4)} | ${String(r.calibrated).padStart(8)} | ${outcome}`);
  }

  console.log('\n🔍 INTERMEDIARE (per categorie):');
  for (const t of TESTS) {
    const r = g2Score(m, t.cat, t.sub, t.thr);
    console.log(`\n  ${t.label}:`);
    for (const [k, v] of Object.entries(r.intermediates)) {
      if (k === 'formula') console.log(`    └ ${v}`);
      else console.log(`    ${k.padEnd(10)} = ${v}`);
    }
    console.log(`    └ raw ${r.raw} → calibrat ${r.calibrated}`);
  }

  console.log('\n');
}

(async () => {
  try { await main(); await pool.end(); process.exit(0); }
  catch (e) { console.error('Eroare:', e.message); console.error(e.stack); await pool.end().catch(() => {}); process.exit(1); }
})();
