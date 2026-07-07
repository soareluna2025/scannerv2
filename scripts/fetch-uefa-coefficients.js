// scripts/fetch-uefa-coefficients.js
// ============================================================================
//  Aduce coeficienții UEFA de club și populează `uefa_club_coefficients`,
//  mapând numele din sursa UEFA pe team_id-urile API-Football din tabela `teams`.
//
//  SURSA (PAS 1): kassiesa.net — cel mai structurat/canonic (HTML static, istoric
//  complet). API-Football NU expune coeficienți UEFA de club (fără endpoint
//  /coefficients — doar /standings per ligă). Fallback: footballseeding.com.
//  NOTĂ: în sandbox-ul de dezvoltare aceste hosturi sunt blocate de politica de
//  egress (403); pe VPS (server normal) sunt accesibile. De aceea structura de
//  parsare se VALIDEAZĂ la prima rulare pe VPS cu --dry-run/--dump.
//
//  Rulare:
//    Validare parsare (nu scrie DB):  node scripts/fetch-uefa-coefficients.js --dry-run
//    Vezi HTML brut (calibrare parser): node scripts/fetch-uefa-coefficients.js --dump=20
//    Real (scrie DB):                 node scripts/fetch-uefa-coefficients.js
//    Raport mapare:                   node scripts/fetch-uefa-coefficients.js --dry-run --report
//    Sursă alternativă:               node scripts/fetch-uefa-coefficients.js --source=footballseeding
//
//  Mapare nume↔team_id (PAS 2): manual-override → gate pe țară → fuzzy
//  (Dice bigrame + Jaccard pe tokeni). Praguri: ≥0.62 auto; 0.45–0.62 „review";
//  <0.45 nemapat (team_id NULL, păstrat cu match_score pt inspecție manuală).
//  Override-uri: scripts/uefa-name-overrides.json { "nume sursă": team_id }.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// NOTĂ: `dotenv` + conexiunea DB se încarcă LENEȘ în main() (dynamic import), ca
// funcțiile pure (normalize/match/parse) să fie importabile în teste fără DB/env.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CURRENT_SEASON = '2025/26';

// ── Surse (URL + parser). value-ul e HTML static parsabil. ──────────────────
export const SOURCES = {
  kassiesa: {
    // Pagina „club ranking" (coeficienți 5 sezoane). Confirmă URL-ul curent pe VPS
    // (schema kassiesa se schimbă rar; --dump ajută la calibrare).
    url: 'https://kassiesa.net/uefa/data/method5/crank2026.html',
    parse: parseGenericTable,
  },
  footballseeding: {
    url: 'https://footballseeding.com/uefa/club-ranking/',
    parse: parseGenericTable,
  },
};

// ── Normalizare nume ────────────────────────────────────────────────────────
export function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
// Tokeni generici de tip-club care NU disting cluburi (se elimină). NU includem
// nume de ORAȘ (kaunas/vilnius) — ele disting exact cazuri ca Žalgiris Kaunas vs Vilnius.
const CLUB_TOKENS = new Set([
  'fc', 'fk', 'cf', 'sc', 'ac', 'afc', 'cd', 'ud', 'us', 'ss', 'ssc', 'nk',
  'hnk', 'gnk', 'rnk', 'sk', 'if', 'if', 'bk', 'ik', 'kf', 'fce', 'fca',
  'club', 'calcio', 'futbol', 'futebol', 'spor', 'kulubu', 'as', 'rc', 'cs',
  'sv', 'tsv', 'vfb', 'vfl', 'fsv', 'sd', 'ca', 'as', 'the', 'de', 'of',
]);
export function normalizeName(s) {
  const base = stripDiacritics(s).toLowerCase()
    .replace(/&[a-z]+;/g, ' ')          // entități HTML
    .replace(/[^a-z0-9]+/g, ' ')        // punctuație → spațiu
    .trim();
  const toks = base.split(/\s+/).filter(t => t && !CLUB_TOKENS.has(t));
  return toks.join(' ').trim() || base;  // dacă totul e strippat, păstrează baza
}
export function tokensOf(s) { return new Set(normalizeName(s).split(/\s+/).filter(Boolean)); }

// ── Similaritate ────────────────────────────────────────────────────────────
export function bigrams(s) {
  const t = normalizeName(s).replace(/\s+/g, '');
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}
export function diceCoefficient(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const [g, c] of A) if (B.has(g)) inter += Math.min(c, B.get(g));
  return (2 * inter) / (Array.from(A.values()).reduce((x, y) => x + y, 0)
                      + Array.from(B.values()).reduce((x, y) => x + y, 0));
}
export function jaccardTokens(a, b) {
  const A = tokensOf(a), B = tokensOf(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
// Scor combinat: bigrame (ortografie) + tokeni (cuvinte comune, ex. „kaunas").
export function matchScore(a, b) {
  return 0.6 * diceCoefficient(a, b) + 0.4 * jaccardTokens(a, b);
}

// ── Țară: normalizare + coduri UEFA/ISO uzuale ──────────────────────────────
const COUNTRY_CODE = {
  kos: 'kosovo', ltu: 'lithuania', lva: 'latvia', est: 'estonia',
  svn: 'slovenia', svk: 'slovakia', cze: 'czech republic', hrv: 'croatia',
  srb: 'serbia', bih: 'bosnia and herzegovina', mkd: 'north macedonia',
  mne: 'montenegro', alb: 'albania', bgr: 'bulgaria', rou: 'romania',
  mda: 'moldova', ukr: 'ukraine', blr: 'belarus', pol: 'poland', hun: 'hungary',
  aut: 'austria', che: 'switzerland', deu: 'germany', ger: 'germany',
  fra: 'france', esp: 'spain', ita: 'italy', prt: 'portugal', por: 'portugal',
  nld: 'netherlands', ned: 'netherlands', bel: 'belgium', gbr: 'england',
  eng: 'england', sco: 'scotland', wal: 'wales', nir: 'northern ireland',
  irl: 'ireland', dnk: 'denmark', den: 'denmark', nor: 'norway', swe: 'sweden',
  fin: 'finland', isl: 'iceland', grc: 'greece', tur: 'turkey', cyp: 'cyprus',
  isr: 'israel', geo: 'georgia', arm: 'armenia', aze: 'azerbaijan',
  kaz: 'kazakhstan', lux: 'luxembourg', mlt: 'malta', and: 'andorra',
  gib: 'gibraltar', far: 'faroe islands', fro: 'faroe islands', smr: 'san marino',
  lie: 'liechtenstein',
};
export function normalizeCountry(c) {
  const s = stripDiacritics(c).toLowerCase().trim();
  if (COUNTRY_CODE[s]) return COUNTRY_CODE[s];
  return s;
}
function sameCountry(a, b) {
  const x = normalizeCountry(a), y = normalizeCountry(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// ── Cel mai bun match pe lista de echipe DB ─────────────────────────────────
// teams = [{team_id, name, country}]. overrides = { "nume sursă lower": team_id }.
// Întoarce {team_id, score, tier, matched_name} — tier: auto|review|none.
export function bestMatch(uefaName, uefaCountry, teams, overrides = {}) {
  const ov = overrides[String(uefaName).toLowerCase().trim()];
  if (ov != null) return { team_id: Number(ov), score: 1, tier: 'override', matched_name: '(override)' };

  // 1) candidați din aceeași țară (dezambiguizare puternică)
  let pool = teams.filter(t => sameCountry(uefaCountry, t.country));
  let scoped = true;
  // 2) fallback: dacă țara nu potrivește nimic, caută în tot setul (prag mai strict)
  if (!pool.length) { pool = teams; scoped = false; }

  let best = { team_id: null, score: 0, matched_name: null };
  for (const t of pool) {
    const sc = matchScore(uefaName, t.name);
    if (sc > best.score) best = { team_id: t.team_id, score: sc, matched_name: t.name };
  }
  const AUTO = scoped ? 0.62 : 0.75;   // fără gate pe țară → prag mai mare
  const REVIEW = 0.45;
  const tier = best.score >= AUTO ? 'auto' : best.score >= REVIEW ? 'review' : 'none';
  return { team_id: tier === 'none' ? null : best.team_id, score: +best.score.toFixed(3),
           tier, matched_name: best.matched_name };
}

// ── Parser HTML generic de tabel (fără dependențe noi) ──────────────────────
// Extrage rânduri <tr>, curăță celulele, și identifică euristic: nume (prima
// celulă alfabetică lungă), țară (cod/nume scurt), coeficient (ultimul număr
// zecimal), rank (primul întreg). Structura EXACTĂ se validează cu --dump pe VPS.
export function parseGenericTable(html) {
  const rows = [];
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const strip = h => stripDiacritics(h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
                       .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [];
    let c;
    tdRe.lastIndex = 0;
    while ((c = tdRe.exec(m[0]))) cells.push(strip(c[1]));
    if (cells.length < 3) continue;
    // rank = primul întreg curat; coefficient = ultimul număr cu zecimale;
    // name = cea mai lungă celulă preponderent-alfabetică; country = celulă scurtă alfabetică.
    const nums = cells.map(x => (x.match(/^-?\d+(?:[.,]\d+)?$/) ? parseFloat(x.replace(',', '.')) : null));
    const rank = nums.find(n => n != null && Number.isInteger(n)) ?? null;
    let coefficient = null;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (/\d[.,]\d/.test(cells[i])) { coefficient = parseFloat(cells[i].replace(',', '.')); break; }
    }
    const alpha = cells.filter(x => /[a-z]/i.test(x) && !/^\d/.test(x));
    if (!alpha.length) continue;
    const name = alpha.reduce((a, b) => (b.length > a.length ? b : a), '');
    const country = alpha.filter(x => x !== name).sort((a, b) => a.length - b.length)[0] || null;
    if (!name || coefficient == null) continue;
    rows.push({ rank, name, country, coefficient });
  }
  return rows;
}

// ── I/O ─────────────────────────────────────────────────────────────────────
async function fetchHtml(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'AlohaScan/1.0 (uefa-coef)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} la ${url}`);
  return await r.text();
}

function loadOverrides() {
  const p = path.join(__dirname, 'uefa-name-overrides.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = {};
    // Ignoră cheile meta (_comment/_exemplu) — doar mapări reale nume→team_id.
    for (const k of Object.keys(raw)) if (!k.startsWith('_')) out[k.toLowerCase()] = raw[k];
    return out;
  } catch { return {}; }
}

async function ensureTable(query) {
  await query(`CREATE TABLE IF NOT EXISTS uefa_club_coefficients (
    id SERIAL PRIMARY KEY, team_id INTEGER, team_name TEXT NOT NULL, country TEXT,
    coefficient NUMERIC, rank INTEGER, season TEXT, match_score NUMERIC,
    updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (season, team_name))`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const getArg = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : d; };
  const DRY = args.includes('--dry-run');
  const REPORT = args.includes('--report');
  const DUMP = parseInt(getArg('dump', '0'), 10);
  await import('dotenv/config');   // încarcă .env pt conexiunea DB (doar la runtime)
  const sourceKey = getArg('source', 'kassiesa');
  const src = SOURCES[sourceKey];
  if (!src) { console.error(`Sursă necunoscută: ${sourceKey}`); process.exit(1); }

  console.log(`[uefa] sursă=${sourceKey} url=${src.url}`);
  let html;
  try { html = await fetchHtml(src.url); }
  catch (e) { console.error(`[uefa] FETCH EȘUAT: ${e.message}\n→ pe VPS hostul e accesibil; în sandbox e blocat de egress (403).`); process.exit(2); }

  if (DUMP > 0) {
    const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    console.log(`[uefa] DUMP primele ${DUMP} rânduri <tr> (pt calibrare parser):`);
    trs.slice(0, DUMP).forEach((t, i) => console.log(`--- tr#${i} ---\n${t.replace(/\s+/g, ' ').slice(0, 400)}`));
    process.exit(0);
  }

  const parsed = src.parse(html).filter(r => r.name && r.coefficient != null);
  console.log(`[uefa] parsate ${parsed.length} cluburi din sursă.`);
  if (!parsed.length) { console.error('[uefa] 0 rânduri — parserul trebuie calibrat (rulează --dump=20).'); process.exit(3); }

  const { query } = await import('../api/db.js');
  const pool = (await import('../api/db.js')).default;
  await ensureTable(query);
  const { rows: teams } = await query('SELECT team_id, name, country FROM teams');
  const overrides = loadOverrides();
  console.log(`[uefa] teams DB=${teams.length}, override-uri=${Object.keys(overrides).length}`);

  let auto = 0, review = 0, none = 0, written = 0;
  const reviewList = [];
  for (const r of parsed) {
    const mm = bestMatch(r.name, r.country, teams, overrides);
    if (mm.tier === 'auto' || mm.tier === 'override') auto++;
    else if (mm.tier === 'review') { review++; reviewList.push({ ...r, ...mm }); }
    else { none++; }

    if (!DRY) {
      await query(
        `INSERT INTO uefa_club_coefficients (team_id, team_name, country, coefficient, rank, season, match_score, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (season, team_name) DO UPDATE SET
           team_id=EXCLUDED.team_id, country=EXCLUDED.country, coefficient=EXCLUDED.coefficient,
           rank=EXCLUDED.rank, match_score=EXCLUDED.match_score, updated_at=NOW()`,
        [mm.team_id, r.name, r.country, r.coefficient, r.rank, CURRENT_SEASON, mm.score]
      );
      written++;
    }
  }

  console.log(`\n[uefa] MAPARE — auto/override: ${auto} | review: ${review} | nemapate: ${none} (total ${parsed.length})`);
  if (!DRY) console.log(`[uefa] scrise în DB: ${written} (sezon ${CURRENT_SEASON}).`);
  if (REPORT && reviewList.length) {
    console.log('\n[uefa] REVIEW (0.45–0.62 — verifică/override manual):');
    reviewList.slice(0, 40).forEach(r =>
      console.log(`  "${r.name}" (${r.country}) → "${r.matched_name}" score=${r.score} team_id=${r.team_id}`));
  }
  if (pool && pool.end) await pool.end();
}

// Rulează main() DOAR la invocare directă (nu la import în teste).
const _isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isMain) main().catch(e => { console.error(e); process.exit(1); });
