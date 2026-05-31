// verify_score4.js — VERIFICARE (read-only) a tagging-ului ADITIV variant A.
// NU atinge scoring. Rulează pe VPS (are .env + rețea + DB):
//   /snap/bin/node verify_score4.js
//
// Confirmă: V.League 1 (id 340) → dataCompleteness='partial' / playerIntelActive=false;
//           Premier League (id 39) → dataCompleteness='complete' / playerIntelActive=true.
// Mecanism: ia un fixture real per ligă (sezon current dinamic), apoi cheamă
//   /api/enrich local cu parametrii lui și citește câmpurile aditive din răspuns.
import 'dotenv/config';

const KEY  = process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY;
const AF   = 'https://v3.football.api-sports.io';
const HDR  = { 'x-apisports-key': KEY };
const PORT = process.env.PORT || 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function af(path) {
  await sleep(200);
  const r = await fetch(`${AF}${path}`, { headers: HDR });
  return r.json();
}

async function currentSeason(leagueId) {
  const d = await af(`/leagues?id=${leagueId}`);
  const lg = (d.response || [])[0];
  const cur = (lg?.seasons || []).find(s => s.current === true);
  return cur ? cur.year : (lg?.seasons || []).reduce((m, s) => Math.max(m, s.year || 0), 0) || null;
}

// Caută un fixture utilizabil: preferă unul recent (last) cu echipe valide.
async function pickFixture(leagueId, season) {
  let d = await af(`/fixtures?league=${leagueId}&season=${season}&last=5`);
  let fx = (d.response || []).find(f => f.teams?.home?.id && f.teams?.away?.id);
  if (fx) return fx;
  d = await af(`/fixtures?league=${leagueId}&season=${season}&next=5`);
  return (d.response || []).find(f => f.teams?.home?.id && f.teams?.away?.id) || null;
}

async function enrichFor(fx) {
  const q = new URLSearchParams({
    h:   fx.teams.home.id,
    a:   fx.teams.away.id,
    fid: fx.fixture.id,
    hn:  fx.teams.home.name || '',
    an:  fx.teams.away.name || '',
    lgid: fx.league?.id || '',
    lg:  fx.league?.name || '',
    dt:  fx.fixture?.date || '',
    status_short: fx.fixture?.status?.short || 'NS',
  });
  const r = await fetch(`http://localhost:${PORT}/api/enrich?${q}`, { signal: AbortSignal.timeout(30000) });
  return r.json();
}

async function checkLeague(label, leagueId, expected) {
  console.log(`\n── ${label} (id ${leagueId}) — așteptat: ${expected} ──`);
  const season = await currentSeason(leagueId);
  if (!season) { console.log('  ✗ fără sezon current'); return { label, ok: false }; }
  const fx = await pickFixture(leagueId, season);
  if (!fx) { console.log(`  ✗ niciun fixture (sezon ${season})`); return { label, ok: false }; }
  console.log(`  fixture ${fx.fixture.id}: ${fx.teams.home.name} vs ${fx.teams.away.name} (${season})`);
  const en = await enrichFor(fx);
  if (en.error) { console.log(`  ✗ enrich error: ${en.error}`); return { label, ok: false }; }
  const dc = en.dataCompleteness, pia = en.playerIntelActive;
  const ok = dc === expected;
  console.log(`  → dataCompleteness=${dc} · playerIntelActive=${pia} · confidence=${en.confidenceScore}`);
  console.log(`  ${ok ? '✅ CORECT' : '❌ NEAȘTEPTAT (expected ' + expected + ')'}`);
  return { label, leagueId, fixture: fx.fixture.id, dataCompleteness: dc, playerIntelActive: pia, expected, ok };
}

async function main() {
  if (!KEY) { console.error('LIPSĂ API_FOOTBALL_KEY'); process.exit(1); }
  console.log('VERIFICARE tagging variant A (playerIntelActive / dataCompleteness)');
  console.log('NOTĂ: rezultatul depinde de prezența REALĂ a formațiilor + player_stats în DB.');
  const r1 = await checkLeague('V.League 1', 340, 'partial');
  const r2 = await checkLeague('Premier League', 39, 'complete');
  console.log('\n══════════ REZUMAT ══════════');
  [r1, r2].forEach(r => console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}: ${r.dataCompleteness ?? '-'} (așteptat ${r.expected})`));
  const allOk = r1.ok && r2.ok;
  console.log(allOk ? '\n✅ TOATE CORECTE' : '\n⚠ Verifică: dacă PL apare partial, lipsesc lineups/player_stats în DB pt acel meci (rulează prematch-enrichment + collect-finished).');
  process.exit(allOk ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
