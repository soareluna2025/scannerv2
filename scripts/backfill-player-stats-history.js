// scripts/backfill-player-stats-history.js
// ─────────────────────────────────────────────────────────────────────────────
// TRACK B — Faza 1: backfill ISTORIC player_stats (per-fixture), fundația
// recompute-ului point-in-time pentru score7.
//
// Selectează fixturile FT dintr-un sezon care NU au niciun rând în player_stats
// și le colectează prin ACEEAȘI funcție de producție (collectFixture din
// api/cron/collect-finished.js) → mapare + INSERT BIT-IDENTICE cu cron-ul viu.
// Rerularea continuă natural: fixturile colectate dispar din selecție, iar cele
// fără date la API sunt marcate (api_markers: ps_backfill_no_data) și excluse.
//
// Rulare (din /root/scannerv2, prin Termius):
//   test:    node scripts/backfill-player-stats-history.js --season=2022 --dry-run
//   real:    nohup node scripts/backfill-player-stats-history.js --season=2022 --rps=3 --max-calls=40000 >> logs/ps-backfill-2022.log 2>&1 &
//   monitor: tail -f /root/scannerv2/logs/ps-backfill-2022.log
//
// NU atinge scoring/enrich/crontab/imutabile. Singura dependență de producție
// modificată: export-ul funcției collectFixture (zero schimbare de logică).
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { query } from '../api/db.js';
import pool from '../api/db.js';
import { collectFixture } from '../api/cron/collect-finished.js';
import { ensureMarkerTable, setMarker } from '../api/utils/markers.js';

const MARKER_KIND = 'ps_backfill_no_data';

// ── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { season: null, rps: 3, maxCalls: 40000, limit: null, dryRun: false };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    switch (key) {
      case 'season':    out.season   = Number(val); break;
      case 'rps':       out.rps      = Number(val); break;
      case 'max-calls': out.maxCalls = Number(val); break;
      case 'limit':     out.limit    = Number(val); break;
      case 'dry-run':   out.dryRun   = true; break;
      default: console.error(`⚠ argument necunoscut: --${key} (ignorat)`);
    }
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}

// Selecție: FT în sezon, FĂRĂ player_stats și FĂRĂ marker de "no data".
// NOT EXISTS folosește idx_player_stats_fixture + PK api_markers → index-friendly.
const SELECT_SQL = `
  SELECT fh.fixture_id
  FROM fixtures_history fh
  WHERE fh.status_short = 'FT' AND fh.season = $1
    AND NOT EXISTS (SELECT 1 FROM player_stats ps WHERE ps.fixture_id = fh.fixture_id)
    AND NOT EXISTS (SELECT 1 FROM api_markers m
                    WHERE m.kind = $2 AND m.ref_key = fh.fixture_id::text)
  ORDER BY fh.match_date ASC
`;

async function main() {
  const args = parseArgs(process.argv);

  // Validare season (obligatoriu, 2018-2026).
  if (!Number.isInteger(args.season) || args.season < 2018 || args.season > 2026) {
    console.error('❌ --season=YYYY obligatoriu, între 2018 și 2026 (ex: --season=2022)');
    process.exit(1);
  }
  if (!Number.isFinite(args.rps) || args.rps <= 0) {
    console.error('❌ --rps trebuie să fie > 0'); process.exit(1);
  }
  if (!Number.isFinite(args.maxCalls) || args.maxCalls <= 0) {
    console.error('❌ --max-calls trebuie să fie > 0'); process.exit(1);
  }
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    console.error('❌ --limit trebuie să fie întreg > 0'); process.exit(1);
  }
  if (!process.env.POSTGRES_URL) {
    console.error('❌ POSTGRES_URL lipsește din .env — rulează din /root/scannerv2'); process.exit(1);
  }

  const sleepMs = Math.max(0, Math.floor(1000 / args.rps));
  const stamp = () => new Date().toISOString();

  // ── DRY-RUN: doar numără selecția, zero apeluri API ──────────────────────────
  if (args.dryRun) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM (${SELECT_SQL}) sub`, [args.season, MARKER_KIND]);
    const total = rows[0]?.n || 0;
    const eff = args.limit != null ? Math.min(args.limit, total) : total;
    console.log(`[ps-backfill ${args.season}] DRY-RUN — fixturi FT fără player_stats (nemarcate): ${total}`);
    if (args.limit != null) console.log(`  cu --limit=${args.limit} → s-ar procesa: ${eff}`);
    console.log(`  (zero apeluri API efectuate)`);
    await pool.end();
    return;
  }

  // ── RUN real ─────────────────────────────────────────────────────────────────
  await ensureMarkerTable();

  let sel = SELECT_SQL;
  const params = [args.season, MARKER_KIND];
  if (args.limit != null) { sel += ` LIMIT $3`; params.push(args.limit); }
  const { rows: fixtures } = await query(sel, params);
  const total = fixtures.length;

  console.log(`[ps-backfill ${args.season}] start ${stamp()}`);
  console.log(`  selecție: ${total} fixturi · rps=${args.rps} (sleep ${sleepMs}ms) · max-calls=${args.maxCalls}` +
              (args.limit != null ? ` · limit=${args.limit}` : ''));
  if (!total) { console.log('  nimic de făcut — selecție goală.'); await pool.end(); return; }

  let processed = 0, insertedRows = 0, emptyMarked = 0, errors = 0, callsMade = 0;
  let stopRequested = false, stopReason = '';
  const startTs = Date.now();

  const onSignal = (sig) => {
    if (stopRequested) { console.log(`\n${sig} din nou → ieșire forțată.`); process.exit(130); }
    stopRequested = true; stopReason = sig;
    console.log(`\n⏹ ${sig} primit — opresc curat după fixture-ul curent…`);
  };
  process.on('SIGINT',  () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const printProgress = () => {
    const elapsed = (Date.now() - startTs) / 1000;
    const rps = elapsed > 0 ? processed / elapsed : 0;
    const remaining = total - processed;
    const eta = rps > 0 ? remaining / rps : Infinity;
    console.log(`[ps-backfill ${args.season}] ${processed}/${total} · inserate=${insertedRows}` +
                ` · goale=${emptyMarked} · erori=${errors} · ${rps.toFixed(2)} req/s · ETA ${fmtDur(eta)}`);
  };

  for (const { fixture_id } of fixtures) {
    if (stopRequested) break;
    if (callsMade >= args.maxCalls) {
      stopReason = `buget max-calls=${args.maxCalls} atins`;
      console.log(`\n🛑 ${stopReason} — oprire curată.`);
      break;
    }

    callsMade++;
    try {
      const n = await collectFixture(fixture_id);   // 1 apel API + INSERT-uri de producție
      if (n > 0) {
        insertedRows += n;
      } else {
        // Răspuns gol la API → marchează ca "no data" ca să nu-l relovim la infinit.
        await setMarker(MARKER_KIND, fixture_id);
        emptyMarked++;
      }
    } catch (e) {
      errors++;
      console.error(`  ✗ fixture ${fixture_id}: ${e.message}`);
    }
    processed++;

    if (processed % 100 === 0) printProgress();
    if (sleepMs > 0 && !stopRequested) await sleep(sleepMs);
  }

  // ── Sumar final ──────────────────────────────────────────────────────────────
  const elapsed = (Date.now() - startTs) / 1000;
  const rps = elapsed > 0 ? processed / elapsed : 0;
  console.log(`\n──────── SUMAR ps-backfill ${args.season} ────────`);
  console.log(`  oprire:        ${stopRequested ? 'semnal ' + stopReason : (stopReason || 'selecție epuizată')}`);
  console.log(`  procesate:     ${processed}/${total}`);
  console.log(`  apeluri API:   ${callsMade}`);
  console.log(`  rânduri player_stats inserate: ${insertedRows}`);
  console.log(`  fixturi goale marcate:         ${emptyMarked}`);
  console.log(`  erori (non-fatale):            ${errors}`);
  console.log(`  durată: ${fmtDur(elapsed)} · rată medie: ${rps.toFixed(2)} req/s`);
  console.log(`  finalizat ${stamp()}`);
  console.log(`  (rerulează aceeași comandă pentru a continua de unde a rămas)`);

  await pool.end();
}

main().catch(async (e) => {
  console.error('❌ eroare fatală:', e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
