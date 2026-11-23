import pool from '../db.js';
const GAMMA = 'https://gamma-api.polymarket.com';
const STRONG_MS = 3 * 3600 * 1000;   // fereastra pentru potrivire sigura
const WEAK_MS = 1 * 3600 * 1000;     // ora aproape exacta pentru potrivire "slaba"
// ---- MATCHER (pur, testat separat) ----
const DROP = new Set(['fc','sc','ac','cf','afc','sco','cd','ud','sd','fk','sk','bk','if','ik','as','ss','us','club','de','the','da','del','la','le','el','cs','ca','cr','sv','vfb','vfl','tsv','sg','fsv','rc','rcd']);
const ALIAS = { lyonnais: 'lyon', internazionale: 'inter', munchen: 'munich', utd: 'united', man: 'manchester', st: 'saint' };
function norm(s) {
  s = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ');
  return s.split(/\s+/).filter(t => t && !DROP.has(t) && !/^\d{4}$/.test(t)).map(t => ALIAS[t] || t);
}
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const g = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const A = g(a), B = g(b); let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0);
  return 2 * inter / ((a.length - 1) + (b.length - 1));
}
function tokMatch(x, y) {
  if (x === y) return 1;
  const m = Math.min(x.length, y.length);
  if (m >= 4 && (x.startsWith(y) || y.startsWith(x))) return 0.9;
  if (m >= 5 && dice(x, y) >= 0.8) return 0.85;
  let cp = 0; while (cp < m && x[cp] === y[cp]) cp++;
  if (cp >= 4 && cp / m >= 0.65) return 0.8;
  return 0;
}
function sim(a, b) {
  const A = norm(a), B = norm(b);
  if (!A.length || !B.length) return 0;
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  const used = new Set(); let sum = 0;
  for (const s of S) {
    let best = 0, bj = -1;
    for (let j = 0; j < L.length; j++) { if (used.has(j)) continue; const v = tokMatch(s, L[j]); if (v > best) { best = v; bj = j; } }
    if (bj >= 0) used.add(bj);
    sum += best;
  }
  const penalty = Math.max(0.7, 1 - 0.1 * (L.length - S.length));
  let res = (sum / S.length) * penalty;
  // abreviere: un singur cuvant scurt care incepe concatenarea cuvintelor celuilalt nume (ADT ~ AD Tarma)
  if (S.length === 1 && L.length > 1 && S[0].length >= 3 && L.join('').startsWith(S[0])) res = Math.max(res, 0.85 * Math.max(0.7, 1 - 0.1 * (L.length - 1)));
  return res;
}
// events: [{slug,title,home,away,t}], fx: [{fixture_id,home_team_name,away_team_name,t}]
function matchAll(events, fx) {
  const cands = [], unmatched = [], ambiguous = [];
  for (const e of events) {
    const list = [];
    for (const f of fx) {
      const d = Math.abs(f.t - e.t);
      if (d > STRONG_MS) continue;
      const n1 = [sim(e.home, f.home_team_name), sim(e.away, f.away_team_name)];
      const n2 = [sim(e.home, f.away_team_name), sim(e.away, f.home_team_name)];
      const s = (n1[0] + n1[1]) >= (n2[0] + n2[1]) ? n1 : n2;
      const total = s[0] + s[1], mn = Math.min(s[0], s[1]);
      let kind = null;
      if (mn >= 0.8) kind = 'sigur';
      else if (d <= 600000 && Math.max(s[0], s[1]) >= 0.85) kind = "ora"; else if (d <= WEAK_MS && total >= 1.3 && mn >= 0.4 && Math.max(s[0], s[1]) >= 0.85) kind = 'slab';
      list.push({ e, f, total, mn, d, kind, score: total - 0.05 * (d / 3600000) });
    }
    list.sort((x, y) => y.score - x.score);
    const best = list[0];
    if (!best || !best.kind) { unmatched.push({ e, best }); continue; }
    const second = list.find(x => x.f.fixture_id !== best.f.fixture_id);
    if (best.kind === 'slab' && second && second.total >= best.total - 0.2) { ambiguous.push({ e, best, second }); continue; }
    cands.push(best);
  }
  cands.sort((x, y) => y.score - x.score);
  const usedF = new Set(), usedE = new Set(), out = [];
  for (const c of cands) {
    if (usedF.has(c.f.fixture_id) || usedE.has(c.e.slug)) { unmatched.push({ e: c.e, best: c }); continue; }
    usedF.add(c.f.fixture_id); usedE.add(c.e.slug); out.push(c);
  }
  return { links: out, unmatched, ambiguous };
}
// ---- END MATCHER ----
async function getJson(url) {
  const r = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const now = Date.now();
await pool.query("CREATE TABLE IF NOT EXISTS polymarket_links (fixture_id BIGINT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, matched_at TIMESTAMPTZ DEFAULT now())");   // idempotent: nu atinge tabela existenta

const sports = await getJson(GAMMA + '/sports');
const series = [...new Set(sports.filter(x => String(x.tags || '').split(',').includes('100350')).map(x => x.series).filter(Boolean))];
console.log(new Date().toISOString(), 'ligi fotbal Polymarket:', series.length);
const fx = (await pool.query(
  "SELECT fixture_id, home_team_name, away_team_name, match_date FROM fixtures WHERE match_date >= now() - interval '4 hours' AND match_date < now() + interval '11 days'"
)).rows.map(f => ({ ...f, t: new Date(f.match_date).getTime() }));
console.log('fixtures AlohaScan in fereastra:', fx.length);
const events = [], seen = new Set(), skipped = [];
function addEvent(e) {
  if (!e || !e.slug || seen.has(e.slug)) return false;
  const title = e.title || "";
  if (/ - /.test(title)) return false;
  const teams = Array.isArray(e.teams) ? e.teams : [];
  const h = teams.find(x => String(x.ordering || "").toLowerCase() === "home");
  const a = teams.find(x => String(x.ordering || "").toLowerCase() === "away");
  const m = /^(.+?) vs\\.? (.+)$/.exec(title);
  const home = h?.name || (m && m[1]);
  const away = a?.name || (m && m[2]);
  const t = Date.parse(e.endDate);
  if (!home || !away || !Number.isFinite(t)) return false;
  if (!/\\d{4}-\\d{2}-\\d{2}$/.test(e.slug)) skipped.push(e.slug + " | " + title);
  seen.add(e.slug);
  events.push({ slug: e.slug, title, home, away, t });
  return true;
}
const win = '&end_date_min=' + iso(now - 4 * 3600e3) + '&end_date_max=' + iso(now + 11 * 864e5) + '&order=endDate&ascending=true';
for (const sid of series) {
  try { for (let off=0;off<4000;off+=200) { const page=await getJson(GAMMA + '/events?series_id=' + sid + '&active=true&closed=false' + win + '&limit=200&offset=' + off); if (!Array.isArray(page)||!page.length) break; for (const e of page) addEvent(e); if (page.length<200) break; } }
  catch (err) { console.log('seria', sid, 'eroare:', err.message); }
}
const viaSeries = events.length;
let viaTag = 0;
try {
  for (let off = 0; off < 3000; off += 100) {
    const page = await getJson(GAMMA + '/events?tag_id=100350&active=true&closed=false' + win + '&limit=100&offset=' + off);
    if (!Array.isArray(page) || !page.length) break;
    for (const e of page) if (addEvent(e)) { viaTag++; if (viaTag <= 15) console.log('NOU-VIA-TAG', e.slug, '|', e.title); }
    if (page.length < 100) break;
  }
} catch (err) { console.log('tag Soccer eroare:', err.message); }
console.log('evenimente principale Polymarket:', events.length, '(via serii', viaSeries, '| in plus via tag Soccer', viaTag + ')');
for (const x of skipped.slice(0, 10)) console.log('SLUG-ATIPIC (acceptat)', x);
const { links, unmatched, ambiguous } = matchAll(events, fx);
try { await pool.query('ALTER TABLE polymarket_links ADD COLUMN IF NOT EXISTS kind text, ADD COLUMN IF NOT EXISTS score numeric(4,2)'); } catch (e) { console.log('alter:', e.message); }
let slabe = 0;
for (const c of links) {
  await pool.query(
    'INSERT INTO polymarket_links (fixture_id, slug, title, matched_at, kind, score) VALUES ($1,$2,$3,now(),$4,$5) ON CONFLICT (fixture_id) DO UPDATE SET slug=EXCLUDED.slug, title=EXCLUDED.title, matched_at=now(), kind=EXCLUDED.kind, score=EXCLUDED.score',
    [c.f.fixture_id, c.e.slug, c.e.title, c.kind, c.total.toFixed(2)]
  );
  if (c.kind === 'slab') { slabe++; console.log('SLAB', c.f.fixture_id, c.f.home_team_name, 'vs', c.f.away_team_name, '<->', c.e.title, '| sc', c.total.toFixed(2)); }
}
for (const a of ambiguous) console.log('AMBIGUU', a.e.slug, '|', a.e.title, '| cand:', a.best.f.home_team_name, 'vs', a.best.f.away_team_name, '/', a.second.f.home_team_name, 'vs', a.second.f.away_team_name);
for (const u of unmatched.filter(u => u.best && u.best.total >= 0.6)) console.log('NELEGAT', u.e.slug, '|', u.e.title, u.best ? '| best: ' + u.best.f.home_team_name + ' vs ' + u.best.f.away_team_name + ' sc ' + u.best.total.toFixed(2) : '| niciun meci AlohaScan la aceasta ora');
console.log('legaturi:', links.length, '(slabe:', slabe + ')', 'ambigue:', ambiguous.length, 'nelegate:', unmatched.length);
const linkedIds = new Set((await pool.query('SELECT fixture_id FROM polymarket_links')).rows.map(r => r.fixture_id));
let miss = 0;
for (const f of fx) {
  if (linkedIds.has(f.fixture_id)) continue;
  let best = null;
  for (const e of events) {
    const d = Math.abs(f.t - e.t); if (d > 24 * 3600000) continue;
    const tot = Math.max(sim(e.home, f.home_team_name) + sim(e.away, f.away_team_name), sim(e.home, f.away_team_name) + sim(e.away, f.home_team_name));
    if (!best || tot > best.tot) best = { e, tot };
  }
  if (best && best.tot >= 0.5 && miss < 25) { miss++; console.log('FARA-LEGATURA', f.fixture_id, f.home_team_name, 'vs', f.away_team_name, '| cel mai apropiat Polymarket:', best.e.title, 'sc', best.tot.toFixed(2)); }
}
console.log('acoperire: fixtures in fereastra', fx.length, '| legate acum', fx.filter(f => linkedIds.has(f.fixture_id)).length, '| fara legatura dar cu candidat', miss);
await pool.end();
