#!/usr/bin/env node
// Generator Backtest — măsoară calibrarea formulei g2Score pe meciuri istorice
//
// Citește meciuri FT din fixtures_history + match_stats + toate datele JOIN
// (league_stats, ref_stats, h2h, form_stats, teams_stats, injuries, venues)
// Pentru fiecare meci, simulează generatorul în mod PRE-MATCH și calculează
// scorul pentru cele 6 categorii × 3 sub-moduri × N praguri.
// Compară cu outcome-ul real și măsoară calibrarea.
//
// Rulare pe VPS:
//   node scripts/generator-backtest.js                # default limit 500
//   node scripts/generator-backtest.js --limit 1000
//   node scripts/generator-backtest.js --json > gen-bt.json
//
// Output: tabel calibrare per categorie + Brier score global

// ── Auto-load .env ────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname_ = dirname(fileURLToPath(import.meta.url));

const envCandidates = [
  join(__dirname_, '..', '.env'),
  resolve(process.cwd(), '.env'),
  '/root/scannerv2/.env',
];
for (const p of envCandidates) {
  if (existsSync(p)) {
    for (let line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      line = line.replace(/^\s*export\s+/, '');
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
    break;
  }
}

if (!process.env.POSTGRES_URL) {
  console.error('❌ POSTGRES_URL nu este setat. Rulează din /root/scannerv2/');
  process.exit(1);
}

import pkg from 'pg';
const { Pool } = pkg;
const url = new URL(process.env.POSTGRES_URL);
const pool = new Pool({
  host: url.hostname,
  port: parseInt(url.port) || 5432,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
});
const query = (t, p) => pool.query(t, p);

// ── Args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const limit = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 500;
})();
const jsonOnly = args.includes('--json');
const log = (...m) => { if (!jsonOnly) console.log(...m); };

// ── g2Score — mirror DIN index.html (linia ~2710) ──────────────
// IMPORTANT: dacă schimbi g2Score în frontend, actualizează și aici.
function g2Poi(lam, k) {
  if (lam <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lam);
  for (let i = 0; i < k; i++) p = p * lam / (i + 1);
  return p;
}
function g2Over(lam, thr) {
  const need = Math.floor(thr) + 1;
  let fail = 0;
  for (let k = 0; k < need; k++) fail += g2Poi(lam, k);
  return Math.max(0, Math.min(100, (1 - fail) * 100));
}

// Variantă fără globals G2 — primește cat/sub/thr ca parametri.
function g2ScorePrematch(m, cat, sub, thr) {
  let s = 0;
  const lg = m.league || { avg_goals: 2.5, pct_over_15: 60, pct_over_25: 40, pct_gg: 50, avg_yellow: 3.5, avg_corners: 9 };
  const ref = m.ref_stats;
  const h2h = m.h2h;
  const fm = m.form || {};

  const fHs = fm.home_avg_scored, fHc = fm.home_avg_conceded;
  const fAs = fm.away_avg_scored, fAc = fm.away_avg_conceded;
  const defLgH = lg.avg_goals * 0.55, defLgA = lg.avg_goals * 0.45;
  const lamH = (fHs != null && fAc != null) ? ((fHs + fAc) / 2) : (fHs != null ? fHs : (fAc != null ? fAc : defLgH));
  const lamA = (fAs != null && fHc != null) ? ((fAs + fHc) / 2) : (fAs != null ? fAs : (fHc != null ? fHc : defLgA));

  if (cat === 'home' || cat === 'away') {
    const isH = (cat === 'home');
    const lam = isH ? lamH : lamA;
    const poisS = g2Over(lam, 0.5);
    const h2hS = isH ? (h2h ? h2h.pct_home_scores : lg.pct_gg) : (h2h ? h2h.pct_away_scores : lg.pct_gg);
    const lgS = lg.pct_gg;
    s = poisS * 0.40 + h2hS * 0.25 + lgS * 0.20 + poisS * 0.15;
  } else if (cat === 'goals') {
    const isT = (!sub || sub === 'total'), isHG = (sub === 'home');
    const lamG = isT ? (lamH + lamA) : (isHG ? lamH : lamA);
    const poisG = g2Over(lamG, thr);
    const lgPct = thr <= 1 ? lg.pct_over_15 : lg.pct_over_25;
    const h2hPct = thr <= 1 ? (h2h ? +(h2h.pct_over_15) : lgPct) : (h2h ? +(h2h.pct_over_25) : lgPct);
    const refG = ref ? g2Over(ref.avg_goals * (isT ? 1 : 0.5), thr) : poisG;
    s = poisG * 0.35 + lgPct * 0.20 + h2hPct * 0.25 + refG * 0.20;
  } else if (cat === 'gg') {
    const pHs = g2Over(lamH, 0.5);
    const pAs = g2Over(lamA, 0.5);
    const pHc = fHc != null ? g2Over(fHc, 0.5) : pAs;
    const pAc = fAc != null ? g2Over(fAc, 0.5) : pHs;
    const compH = (pHs / 100) * (pAc / 100) * 100;
    const compA = (pAs / 100) * (pHc / 100) * 100;
    const h2hGG = h2h ? +(h2h.pct_gg) : lg.pct_gg;
    s = compH * 0.35 + compA * 0.35 + h2hGG * 0.30;
  } else if (cat === 'cards') {
    const isTC = (!sub || sub === 'total'), isHC = (sub === 'home');
    const refYC = ref ? ref.avg_yellow : null;
    const lgYC = lg.avg_yellow;
    let defIntensity = 1.0;
    if (fHc != null && fAc != null) defIntensity = Math.min(1.4, Math.max(0.7, (fHc + fAc) / lg.avg_goals));
    const avgC = (refYC || lgYC) * defIntensity;
    const lamC = isTC ? avgC : (isHC ? avgC * 0.55 : avgC * 0.45);
    const poisC = g2Over(lamC, thr);
    const refC = refYC ? g2Over(refYC * defIntensity * (isTC ? 1 : (isHC ? 0.55 : 0.45)), thr) : poisC;
    const lgC = g2Over(lgYC * defIntensity * (isTC ? 1 : (isHC ? 0.55 : 0.45)), thr);
    s = refC * 0.40 + lgC * 0.25 + poisC * 0.35;
  } else if (cat === 'corners') {
    const isTK = (!sub || sub === 'total'), isHK = (sub === 'home');
    const refK = ref ? ref.avg_corners : null;
    const lgK = lg.avg_corners;
    let attFactor = 1.0;
    if (fHs != null && fAs != null) attFactor = Math.min(1.4, Math.max(0.7, (fHs + fAs) / lg.avg_goals));
    const avgK = (refK || lgK) * attFactor;
    const lamK = isTK ? avgK : (isHK ? avgK * 0.55 : avgK * 0.45);
    const poisK = g2Over(lamK, thr);
    const refKS = refK ? g2Over(refK * attFactor * (isTK ? 1 : (isHK ? 0.55 : 0.45)), thr) : poisK;
    const lgKS = g2Over(lgK * attFactor * (isTK ? 1 : (isHK ? 0.55 : 0.45)), thr);
    s = refKS * 0.30 + lgKS * 0.30 + poisK * 0.40;
  }

  // Injury penalty
  const inj = m.injuries || {};
  const hInj = inj.home || 0, aInj = inj.away || 0;
  let injPenalty = 0;
  if (hInj >= 3) injPenalty += 8;
  if (aInj >= 3) injPenalty += 8;
  if (cat === 'gg' && hInj >= 2 && aInj >= 2) injPenalty = Math.max(injPenalty, 12);
  s = Math.max(0, s - injPenalty);

  // Venue surface
  const surf = m.venue_surface || '';
  if (surf === 'artificial') {
    if (cat === 'goals' || cat === 'home' || cat === 'away' || cat === 'gg') s = Math.min(100, s * 1.05);
    else if (cat === 'corners') s = Math.min(100, s * 1.08);
    else if (cat === 'cards') s = Math.max(0, s * 0.97);
  }

  // GG clean sheets penalty
  if (cat === 'gg') {
    const csH = fm.home_cs_rate || 0, csA = fm.away_cs_rate || 0;
    if (csH > 0.35) s = Math.max(0, s * (1 - (csH - 0.35)));
    if (csA > 0.35) s = Math.max(0, s * (1 - (csA - 0.35)));
  }

  return Math.round(Math.max(0, Math.min(100, s)));
}

// ── Load match data (replică din /api/generator dar pe meciuri istorice) ──

async function loadMatchData(fhRows) {
  // Aggregate lookup-uri batch pentru performanță
  const leagueIds = [...new Set(fhRows.map(r => r.league_id).filter(Boolean))];
  const allTeamIds = [...new Set([
    ...fhRows.map(r => r.home_team_id),
    ...fhRows.map(r => r.away_team_id),
  ].filter(Boolean))];

  const [lsRes, fsRes, tsRes] = await Promise.all([
    query('SELECT * FROM league_stats WHERE league_id = ANY($1)', [leagueIds]).catch(() => ({ rows: [] })),
    query('SELECT * FROM form_stats WHERE team_id = ANY($1)', [allTeamIds]).catch(() => ({ rows: [] })),
    query(`SELECT DISTINCT ON (team_id) team_id, avg_goals_for, avg_goals_against,
             clean_sheets_home, clean_sheets_away, played_home, played_away
           FROM teams_stats WHERE team_id = ANY($1) ORDER BY team_id, season DESC`, [allTeamIds]).catch(() => ({ rows: [] })),
  ]);

  const leagueMap = Object.fromEntries(lsRes.rows.map(r => [Number(r.league_id), r]));
  const tsMap = Object.fromEntries(tsRes.rows.map(r => [Number(r.team_id), r]));
  const formMap = {};
  for (const r of fsRes.rows) {
    const k = `${r.team_id}-${r.league_id}`;
    if (!formMap[k] || formMap[k].season < r.season) formMap[k] = r;
  }

  // H2H bulk
  const pairs = fhRows.map(r => ({
    t1: Math.min(r.home_team_id, r.away_team_id),
    t2: Math.max(r.home_team_id, r.away_team_id),
  })).filter(p => p.t1 && p.t2);
  let h2hMap = {};
  if (pairs.length) {
    const t1arr = pairs.map(p => p.t1);
    const t2arr = pairs.map(p => p.t2);
    const { rows: h2hRows } = await query(`
      WITH pairs AS (SELECT unnest($1::int[]) AS t1, unnest($2::int[]) AS t2)
      SELECT h.team1_id, h.team2_id,
        COUNT(*) AS total,
        AVG(h.home_goals + h.away_goals)::NUMERIC(4,2) AS avg_goals,
        (100.0 * COUNT(*) FILTER (WHERE h.home_goals + h.away_goals >= 2) / COUNT(*))::NUMERIC(5,2) AS pct_over_15,
        (100.0 * COUNT(*) FILTER (WHERE h.home_goals + h.away_goals >= 3) / COUNT(*))::NUMERIC(5,2) AS pct_over_25,
        (100.0 * COUNT(*) FILTER (WHERE h.home_goals > 0 AND h.away_goals > 0) / COUNT(*))::NUMERIC(5,2) AS pct_gg,
        (100.0 * COUNT(*) FILTER (WHERE h.home_goals > 0) / COUNT(*))::NUMERIC(5,2) AS pct_home_scores,
        (100.0 * COUNT(*) FILTER (WHERE h.away_goals > 0) / COUNT(*))::NUMERIC(5,2) AS pct_away_scores
      FROM h2h h
      JOIN pairs p ON h.team1_id = p.t1 AND h.team2_id = p.t2
      GROUP BY h.team1_id, h.team2_id
    `, [t1arr, t2arr]).catch(() => ({ rows: [] }));
    h2hMap = Object.fromEntries(h2hRows.map(r => [`${r.team1_id}-${r.team2_id}`, r]));
  }

  return { leagueMap, tsMap, formMap, h2hMap };
}

// ── Build match object (similar cu generator.js result format) ──

function buildMatch(fh, ctx) {
  const lg = ctx.leagueMap[fh.league_id] || {};
  const hForm = ctx.formMap[`${fh.home_team_id}-${fh.league_id}`] || null;
  const aForm = ctx.formMap[`${fh.away_team_id}-${fh.league_id}`] || null;
  const hTS = ctx.tsMap[fh.home_team_id] || null;
  const aTS = ctx.tsMap[fh.away_team_id] || null;
  const h2h = ctx.h2hMap[`${Math.min(fh.home_team_id, fh.away_team_id)}-${Math.max(fh.home_team_id, fh.away_team_id)}`] || null;

  return {
    fixture_id: fh.fixture_id,
    is_live: false,
    league: {
      avg_goals: +(lg.avg_goals_per_match) || 2.5,
      pct_over_15: +(lg.pct_over_15) || 60,
      pct_over_25: +(lg.pct_over_25) || 40,
      pct_gg: +(lg.pct_gg) || 50,
      avg_yellow: +(lg.avg_yellow_cards) || 3.5,
      avg_corners: +(lg.avg_corners) || 9,
    },
    ref_stats: null,  // skipped pentru backtest (necesită JOIN suplimentar; impact mic)
    h2h: h2h ? {
      total: +(h2h.total),
      avg_goals: +(h2h.avg_goals),
      pct_over_15: +(h2h.pct_over_15),
      pct_over_25: +(h2h.pct_over_25),
      pct_gg: +(h2h.pct_gg),
      pct_home_scores: +(h2h.pct_home_scores),
      pct_away_scores: +(h2h.pct_away_scores),
    } : null,
    form: {
      home_avg_scored: hForm ? +(hForm.avg_scored_home) : (hTS ? +(hTS.avg_goals_for) : null),
      home_avg_conceded: hForm ? +(hForm.avg_conceded_home) : (hTS ? +(hTS.avg_goals_against) : null),
      away_avg_scored: aForm ? +(aForm.avg_scored_away) : (aTS ? +(aTS.avg_goals_for) : null),
      away_avg_conceded: aForm ? +(aForm.avg_conceded_away) : (aTS ? +(aTS.avg_goals_against) : null),
      home_cs_rate: hTS && hTS.played_home > 0 ? +(hTS.clean_sheets_home / hTS.played_home).toFixed(2) : null,
      away_cs_rate: aTS && aTS.played_away > 0 ? +(aTS.clean_sheets_away / aTS.played_away).toFixed(2) : null,
    },
    venue_surface: null,
    injuries: { home: 0, away: 0 },  // skipped
  };
}

// ── Outcome resolver — pe baza fixtures_history + match_stats ──

function resolveOutcome(fh, cat, sub, thr, msAgg) {
  const hg = fh.home_goals || 0;
  const ag = fh.away_goals || 0;

  if (cat === 'home') return hg > 0;
  if (cat === 'away') return ag > 0;
  if (cat === 'gg') return hg > 0 && ag > 0;
  if (cat === 'goals') {
    const total = sub === 'home' ? hg : sub === 'away' ? ag : hg + ag;
    return total > thr;
  }
  if (cat === 'cards') {
    if (!msAgg) return null;  // no data → skip
    const total = sub === 'home' ? msAgg.home_yellow : sub === 'away' ? msAgg.away_yellow : (msAgg.home_yellow + msAgg.away_yellow);
    return total > thr;
  }
  if (cat === 'corners') {
    if (!msAgg) return null;
    const total = sub === 'home' ? msAgg.home_corners : sub === 'away' ? msAgg.away_corners : (msAgg.home_corners + msAgg.away_corners);
    return total > thr;
  }
  return null;
}

// ── Test config ──

const TESTS = [
  { cat: 'home', sub: null, thr: 0, label: 'Gazde marchează' },
  { cat: 'away', sub: null, thr: 0, label: 'Oaspeți marchează' },
  { cat: 'gg', sub: null, thr: 0, label: 'GG' },
  { cat: 'goals', sub: 'total', thr: 0.5, label: 'Over 0.5 total' },
  { cat: 'goals', sub: 'total', thr: 1.5, label: 'Over 1.5 total' },
  { cat: 'goals', sub: 'total', thr: 2.5, label: 'Over 2.5 total' },
  { cat: 'goals', sub: 'home', thr: 0.5, label: 'Over 0.5 gazde' },
  { cat: 'goals', sub: 'home', thr: 1.5, label: 'Over 1.5 gazde' },
  { cat: 'goals', sub: 'away', thr: 0.5, label: 'Over 0.5 oaspeți' },
  { cat: 'goals', sub: 'away', thr: 1.5, label: 'Over 1.5 oaspeți' },
  { cat: 'cards', sub: 'total', thr: 2.5, label: 'Cards Over 2.5' },
  { cat: 'cards', sub: 'total', thr: 4.5, label: 'Cards Over 4.5' },
  { cat: 'corners', sub: 'total', thr: 6.5, label: 'Corners Over 6.5' },
  { cat: 'corners', sub: 'total', thr: 8.5, label: 'Corners Over 8.5' },
];

// ── Main backtest ──

async function main() {
  log(`\n🎯 Generator Backtest — limit ${limit} meciuri\n`);
  log('📊 Selectez meciuri FT din fixtures_history...');

  const { rows: fhRows } = await query(`
    SELECT fixture_id, league_id, home_team_id, away_team_id,
           home_goals, away_goals, match_date
    FROM fixtures_history
    WHERE status_short = 'FT'
      AND home_goals IS NOT NULL AND away_goals IS NOT NULL
      AND league_id IS NOT NULL
      AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
    ORDER BY match_date DESC NULLS LAST
    LIMIT $1
  `, [limit]);

  log(`   ${fhRows.length} meciuri găsite.`);
  if (!fhRows.length) { await pool.end(); return; }

  log('🔍 Încarc match_stats (cards, corners)...');
  const { rows: msRows } = await query(
    `SELECT fixture_id, team_id, yellow_cards, corner_kicks FROM match_stats WHERE fixture_id = ANY($1)`,
    [fhRows.map(r => r.fixture_id)]
  ).catch(() => ({ rows: [] }));

  // Aggregate match_stats: home/away per fixture
  const msAgg = {};
  for (const ms of msRows) {
    if (!msAgg[ms.fixture_id]) msAgg[ms.fixture_id] = {};
    msAgg[ms.fixture_id][ms.team_id] = { y: ms.yellow_cards || 0, c: ms.corner_kicks || 0 };
  }
  for (const fh of fhRows) {
    const agg = msAgg[fh.fixture_id];
    if (!agg) continue;
    msAgg[fh.fixture_id] = {
      home_yellow: agg[fh.home_team_id]?.y || 0,
      away_yellow: agg[fh.away_team_id]?.y || 0,
      home_corners: agg[fh.home_team_id]?.c || 0,
      away_corners: agg[fh.away_team_id]?.c || 0,
    };
  }
  log(`   ${Object.keys(msAgg).length} meciuri cu stats disponibile.`);

  log('🔗 Încarc JOIN-uri: leagues, form, teams, h2h...');
  const ctx = await loadMatchData(fhRows);
  log(`   ${Object.keys(ctx.leagueMap).length} ligi, ${Object.keys(ctx.formMap).length} form_stats, ${Object.keys(ctx.h2hMap).length} h2h.`);

  log('🧮 Calculez scoruri pentru fiecare meci × test...');
  const samples = {};
  for (const t of TESTS) samples[t.label] = [];

  for (const fh of fhRows) {
    const m = buildMatch(fh, ctx);
    for (const t of TESTS) {
      const score = g2ScorePrematch(m, t.cat, t.sub, t.thr);
      const outcome = resolveOutcome(fh, t.cat, t.sub, t.thr, msAgg[fh.fixture_id]);
      if (outcome === null) continue;  // skip dacă nu avem date pentru cards/corners
      samples[t.label].push({ score, hit: outcome });
    }
  }

  // ── Calibrare per test ──
  const report = { meta: { limit, fixtures: fhRows.length }, tests: {} };
  for (const t of TESTS) {
    const sm = samples[t.label];
    if (!sm.length) continue;

    // Buckets 0-10, 10-20, ..., 90-100
    const buckets = [];
    for (let i = 0; i < 10; i++) buckets.push({ range: `${i * 10}-${(i + 1) * 10}%`, count: 0, hits: 0 });
    for (const s of sm) {
      const idx = Math.min(9, Math.floor(s.score / 10));
      buckets[idx].count++;
      if (s.hit) buckets[idx].hits++;
    }

    const brier = sm.reduce((sum, s) => sum + Math.pow(s.score / 100 - (s.hit ? 1 : 0), 2), 0) / sm.length;

    report.tests[t.label] = {
      samples: sm.length,
      hits: sm.filter(s => s.hit).length,
      rate: +(100 * sm.filter(s => s.hit).length / sm.length).toFixed(1),
      brier: +brier.toFixed(4),
      buckets: buckets.map(b => ({
        range: b.range,
        n: b.count,
        actualRate: b.count > 0 ? +(100 * b.hits / b.count).toFixed(1) : null,
      })),
    };
  }

  return report;
}

// ── Output ──

function printReport(r) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  REZULTATE GENERATOR BACKTEST (PRE-MATCH)');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`Meciuri analizate: ${r.meta.fixtures}\n`);

  console.log('📊 BRIER SCORE per test (lower = better; 0.25 = random)');
  console.log('─────────────────────────────────────────────────────────────');
  for (const [label, t] of Object.entries(r.tests)) {
    const stars = t.brier < 0.18 ? '✓✓' : t.brier < 0.22 ? '✓ ' : t.brier < 0.25 ? '⚡' : '⚠';
    console.log(`${label.padEnd(28)} | Brier ${t.brier.toFixed(4)} | rate real ${String(t.rate).padStart(5)}% | n=${t.samples} ${stars}`);
  }

  console.log('\n📈 CURBE CALIBRARE per test:');
  for (const [label, t] of Object.entries(r.tests)) {
    console.log(`\n${label} (n=${t.samples}, rate global ${t.rate}%):`);
    console.log('   range      | n     | actual | bias');
    console.log('   ──────────────────────────────────────');
    for (const b of t.buckets) {
      if (b.n === 0) continue;
      const mid = (parseInt(b.range) + parseInt(b.range.split('-')[1])) / 2;
      const bias = b.actualRate !== null ? (b.actualRate - mid).toFixed(1) : 'N/A';
      const flag = b.actualRate !== null ? (Math.abs(b.actualRate - mid) > 15 ? '⚠️' : Math.abs(b.actualRate - mid) > 8 ? '⚡' : '✓') : '';
      console.log(`   ${b.range.padEnd(10)} | ${String(b.n).padStart(5)} | ${(b.actualRate !== null ? b.actualRate.toFixed(1) + '%' : 'N/A').padStart(6)} | ${String(bias).padStart(6)} ${flag}`);
    }
  }
  console.log('\nLegend Brier: ✓✓ <0.18 excelent  ✓ <0.22 bun  ⚡ <0.25 mediu  ⚠ >0.25 slab');
  console.log('Bias: pozitiv = subestimare, negativ = supraestimare. ✓<8pp ⚡8-15pp ⚠️>15pp\n');
}

// ── Run ──
(async () => {
  try {
    const r = await main();
    if (r) {
      if (jsonOnly) console.log(JSON.stringify(r, null, 2));
      else printReport(r);
    }
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('Eroare:', e.message);
    console.error(e.stack);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
