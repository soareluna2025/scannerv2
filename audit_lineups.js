// audit_lineups.js — AUDIT READ-ONLY: pe ce ligi există REAL formații (lineups).
// Nu atinge nicio logică de scoring. Standalone.
// Rulare: /snap/bin/node audit_lineups.js   (sau: node audit_lineups.js)
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { ALLOWED_LEAGUE_IDS } from './api/leagues.js';

const KEY  = process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const HDR  = { 'x-apisports-key': KEY };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch cu delay 200ms + backoff/retry la 429
async function api(path, attempt = 0) {
  await sleep(200);
  const res = await fetch(`${BASE}${path}`, { headers: HDR });
  if (res.status === 429 && attempt < 3) {
    const wait = 2000 * (attempt + 1);
    console.warn(`  429 — backoff ${wait}ms (retry ${attempt + 1})`);
    await sleep(wait);
    return api(path, attempt + 1);
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function currentSeason(leagueId) {
  const { data } = await api(`/leagues?id=${leagueId}`);
  const lg = (data.response || [])[0];
  if (!lg) return { name: null, season: null };
  const cur = (lg.seasons || []).find(s => s.current === true);
  // fallback: cel mai mare an dacă niciunul nu e marcat current
  const season = cur ? cur.year
    : (lg.seasons || []).reduce((mx, s) => Math.max(mx, s.year || 0), 0) || null;
  return { name: lg.league?.name || null, country: lg.country?.name || '', season };
}

async function leagueHasLineups(leagueId, season) {
  const { data } = await api(`/fixtures?league=${leagueId}&season=${season}&last=3`);
  const fixtures = data.response || [];
  for (const fx of fixtures) {
    const fid = fx.fixture?.id;
    if (!fid) continue;
    const lu = await api(`/fixtures/lineups?fixture=${fid}`);
    if ((lu.data.results || 0) > 0) return { has: true, checked: fid };
  }
  return { has: false, checked: fixtures[0]?.fixture?.id || null, nFixtures: fixtures.length };
}

async function main() {
  if (!KEY) { console.error('LIPSĂ API_FOOTBALL_KEY în .env'); process.exit(1); }
  const ids = [...new Set(ALLOWED_LEAGUE_IDS)]; // dedupe
  console.log(`Audit lineups pe ${ids.length} ligi whitelisted...\n`);

  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const { name, country, season } = await currentSeason(id);
      if (!season) {
        results.push({ id, name: name || '?', country: country || '', season: null, has: false, note: 'fără sezon' });
        console.log(`[${i + 1}/${ids.length}] ${id} ${name || '?'} → fără sezon`);
        continue;
      }
      const lu = await leagueHasLineups(id, season);
      results.push({ id, name: name || '?', country: country || '', season, has: lu.has, note: lu.has ? `fid ${lu.checked}` : `0 din ${lu.nFixtures ?? 0} meciuri` });
      console.log(`[${i + 1}/${ids.length}] ${id} ${name || '?'} (${season}) → ${lu.has ? 'CU formații' : 'FĂRĂ'}`);
    } catch (e) {
      results.push({ id, name: '?', country: '', season: null, has: false, note: `eroare: ${e.message}` });
      console.log(`[${i + 1}/${ids.length}] ${id} → EROARE ${e.message}`);
    }
  }

  const cu  = results.filter(r => r.has);
  const fara = results.filter(r => !r.has);

  console.log('\n══════════ LIGI CU FORMAȚII (' + cu.length + ') ══════════');
  cu.forEach(r => console.log(`  ${r.id}  ${r.country} — ${r.name} (${r.season})`));
  console.log('\n══════════ LIGI FĂRĂ FORMAȚII (' + fara.length + ') ══════════');
  fara.forEach(r => console.log(`  ${r.id}  ${r.country} — ${r.name} (${r.season || '-'})  [${r.note}]`));

  // CSV cu 2 grupuri separate
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let csv = 'grup,league_id,country,league_name,season,are_formatii,note\n';
  for (const r of cu)   csv += `CU_FORMATII,${r.id},${esc(r.country)},${esc(r.name)},${r.season ?? ''},true,${esc(r.note)}\n`;
  for (const r of fara) csv += `FARA_FORMATII,${r.id},${esc(r.country)},${esc(r.name)},${r.season ?? ''},false,${esc(r.note)}\n`;
  writeFileSync('lineup_audit.csv', csv);
  console.log(`\n✓ Salvat lineup_audit.csv (${results.length} ligi: ${cu.length} cu / ${fara.length} fără)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
