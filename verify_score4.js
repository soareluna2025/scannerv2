// verify_score4.js — VERIFICARE (read-only) a tagging-ului ADITIV variant A.
// NU atinge scoring. Rulează pe VPS (are .env + rețea + DB):
//   /snap/bin/node verify_score4.js
//
// Ligi testate (în sezon acum — evităm PL off-season):
//   V.League 1 (340)     → așteptat 'partial'
//   Brazil Serie A (71)  → așteptat 'complete'
//   MLS (253)            → așteptat 'complete'
// Pentru fiecare: cel mai recent fixture TERMINAT (sezon current dinamic) → /api/enrich
//   local → citește dataCompleteness + playerIntelActive. La 'partial', defalcă
//   care condiție a picat (teamStrength home/away / lineups).
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

// Cel mai recent fixture TERMINAT (FT/AET/PEN) cu echipe valide.
async function pickFinishedFixture(leagueId, season) {
  const d = await af(`/fixtures?league=${leagueId}&season=${season}&last=10`);
  const list = (d.response || []).filter(f =>
    f.teams?.home?.id && f.teams?.away?.id &&
    ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short));
  // last=10 vine deja recent→vechi; ia primul terminat
  return list[0] || null;
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
    status_short: fx.fixture?.status?.short || 'FT',
  });
  const r = await fetch(`http://localhost:${PORT}/api/enrich?${q}`, { signal: AbortSignal.timeout(30000) });
  return r.json();
}

async function checkLeague(label, leagueId, expected) {
  console.log(`\n── ${label} (id ${leagueId}) — așteptat: ${expected} ──`);
  const season = await currentSeason(leagueId);
  if (!season) { console.log('  ✗ fără sezon current'); return { label, expected, ok: false }; }
  const fx = await pickFinishedFixture(leagueId, season);
  if (!fx) { console.log(`  ✗ niciun fixture terminat (sezon ${season})`); return { label, expected, ok: false }; }
  console.log(`  fixture ${fx.fixture.id} [${fx.fixture.status.short}]: ${fx.teams.home.name} vs ${fx.teams.away.name} (${season})`);
  const en = await enrichFor(fx);
  if (en.error) { console.log(`  ✗ enrich error: ${en.error}`); return { label, expected, ok: false }; }

  const dc  = en.dataCompleteness;
  const pia = en.playerIntelActive;
  const ok  = dc === expected;
  console.log(`  → dataCompleteness=${dc} · playerIntelActive=${pia} · confidence=${en.confidenceScore}`);

  // DEFALCARE condiții (variant A): playerIntelActive =
  //   (teamStrengthHome != null) AND (teamStrengthAway != null) AND lineupFactor.hasData
  // teamStrength* sunt în payload; hasData NU e expus direct → îl INFERĂM:
  //   dacă ambele strength prezente dar 'partial' → lineups au picat (hasData=false).
  //   dacă o strength lipsește → aceea e cauza; hasData rămâne „gated/necunoscut".
  if (dc === 'partial') {
    const sH = en.teamStrengthHome != null;
    const sA = en.teamStrengthAway != null;
    let lineupHasData;
    if (sH && sA) lineupHasData = false;             // strength OK ambele → lineups au picat
    else          lineupHasData = '? (gated de strength lipsă)';
    console.log('  ⤷ DEFALCARE condiții PARTIAL:');
    console.log(`       teamStrengthHome prezent: ${sH}` + (sH ? '' : '   ← LIPSĂ (player_stats home)'));
    console.log(`       teamStrengthAway prezent: ${sA}` + (sA ? '' : '   ← LIPSĂ (player_stats away)'));
    console.log(`       lineupFactor.hasData:     ${lineupHasData}` + (lineupHasData === false ? '   ← LIPSĂ (lineups <7/11 sau absente)' : ''));
    // diagnostic sintetic
    const cauze = [];
    if (!sH) cauze.push('player_stats HOME');
    if (!sA) cauze.push('player_stats AWAY');
    if (sH && sA && lineupHasData === false) cauze.push('lineups (prematch_data)');
    console.log(`       → gol de date la: ${cauze.length ? cauze.join(' + ') : 'necunoscut'}`);
  }

  console.log(`  ${ok ? '✅ CORECT' : '❌ NEAȘTEPTAT (expected ' + expected + ')'}`);
  return { label, leagueId, fixture: fx.fixture.id, dataCompleteness: dc, playerIntelActive: pia, expected, ok };
}

async function main() {
  if (!KEY) { console.error('LIPSĂ API_FOOTBALL_KEY'); process.exit(1); }
  console.log('VERIFICARE tagging variant A (playerIntelActive / dataCompleteness)');
  console.log('NOTĂ: rezultatul depinde de prezența REALĂ a formațiilor + player_stats în DB.\n');
  const results = [];
  results.push(await checkLeague('V.League 1',    340, 'partial'));
  results.push(await checkLeague('Brazil Serie A', 71, 'complete'));
  results.push(await checkLeague('MLS',           253, 'complete'));

  console.log('\n══════════ REZUMAT ══════════');
  results.forEach(r => console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}: ${r.dataCompleteness ?? '-'} (așteptat ${r.expected})`));
  const allOk = results.every(r => r.ok);
  console.log(allOk
    ? '\n✅ TOATE CORECTE'
    : '\n⚠ Dacă o ligă „în sezon" iese partial: vezi DEFALCAREA de mai sus — lipsesc'
      + ' player_stats (rulează collect-finished) și/sau lineups (prematch-enrichment).');
  process.exit(allOk ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
