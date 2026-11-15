// Sincronizare Polymarket -> polymarket_links. Independent de predictii/LIVE.
import pool from '../db.js';
const GAMMA = 'https://gamma-api.polymarket.com';
const MAX_DIFF_MS = 3 * 3600 * 1000;
const DROP = new Set(['fc','sc','ac','cf','afc','sco','cd','ud','sd','fk','sk','bk','if','ik','as','ss','us','club','de','the','1901','1932','1899','1909','1846','1908','1907']);
const ALIAS = { lyonnais: 'lyon', internazionale: 'inter', munchen: 'munich' };
function norm(s) {
  s = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9 ]+/g, ' ');
  return s.split(/\s+/).filter(t => t && !DROP.has(t)).map(t => ALIAS[t] || t);
}
function sameTeam(a, b) {
  const A = norm(a), B = norm(b);
  if (!A.length || !B.length) return false;
  if (A.join(' ') === B.join(' ')) return true;
  const [s, l] = A.length <= B.length ? [A, B] : [B, A];
  return s.every(t => l.includes(t));
}
async function getJson(url) {
  const r = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const now = Date.now();
const sports = await getJson(GAMMA + '/sports');
const series = [...new Set(sports.filter(x => String(x.tags || '').split(',').includes('100350')).map(x => x.series).filter(Boolean))];
console.log(new Date().toISOString(), 'ligi fotbal Polymarket:', series.length);
const fx = (await pool.query(
  "SELECT fixture_id, home_team_name, away_team_name, match_date FROM fixtures WHERE match_date >= now() - interval '4 hours' AND match_date < now() + interval '11 days'"
)).rows;
console.log('fixtures AlohaScan in fereastra:', fx.length);
const events = [];
for (const sid of series) {
  try {
    const url = GAMMA + '/events?series_id=' + sid + '&active=true&closed=false&end_date_min=' + iso(now - 4 * 3600e3) + '&end_date_max=' + iso(now + 11 * 864e5) + '&order=endDate&ascending=true&limit=200';
    for (const e of await getJson(url)) {
      if (!/\d{4}-\d{2}-\d{2}$/.test(e.slug || '')) continue;
      const m = /^(.+?) vs\.? (.+)$/.exec(e.title || '');
      if (!m || / - /.test(e.title)) continue;
      events.push({ slug: e.slug, title: e.title, home: m[1], away: m[2], t: Date.parse(e.endDate) });
    }
  } catch (err) { console.log('seria', sid, 'eroare:', err.message); }
}
console.log('evenimente principale Polymarket:', events.length);
let linked = 0;
for (const e of events) {
  let best = null, bd = Infinity;
  for (const f of fx) {
    const d = Math.abs(new Date(f.match_date).getTime() - e.t);
    if (d > MAX_DIFF_MS || d >= bd) continue;
    if (sameTeam(e.home, f.home_team_name) && sameTeam(e.away, f.away_team_name)) { best = f; bd = d; }
  }
  if (!best) continue;
  await pool.query(
    'INSERT INTO polymarket_links (fixture_id, slug, title, matched_at) VALUES ($1,$2,$3,now()) ON CONFLICT (fixture_id) DO UPDATE SET slug=EXCLUDED.slug, title=EXCLUDED.title, matched_at=now()',
    [best.fixture_id, e.slug, e.title]
  );
  linked++;
  console.log('LEGAT', best.fixture_id, best.home_team_name, 'vs', best.away_team_name, '->', e.slug);
}
console.log('legaturi scrise/actualizate:', linked);
await pool.end();
