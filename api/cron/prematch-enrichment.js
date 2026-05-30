import { query } from '../db.js';

const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';

function log(msg) { console.log(`[prematch-enrichment] ${new Date().toISOString()} ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Etapele bazate pe orele rămase până la kickoff
const STAGES = [
  { stage: 1, hoursMin: 23,   hoursMax: 25  },
  { stage: 2, hoursMin: 11,   hoursMax: 13  },
  { stage: 3, hoursMin: 5,    hoursMax: 7   },
  { stage: 4, hoursMin: 2.5,  hoursMax: 3.5 },
  { stage: 5, hoursMin: 1.5,  hoursMax: 2.5 },
  { stage: 6, hoursMin: 0.75, hoursMax: 1.5 },
  { stage: 7, hoursMin: 0,    hoursMax: 0.5 },
];

async function apiFetch(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'x-apisports-key': FOOTBALL_KEY },
  });
  return r.json();
}

async function initTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS prematch_enrichment_log (
      fixture_id INTEGER,
      stage      INTEGER,
      executed_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (fixture_id, stage)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS prematch_data (
      fixture_id   INTEGER,
      stage        INTEGER,
      data_type    VARCHAR(50),
      payload      JSONB,
      collected_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (fixture_id, stage, data_type)
    )
  `);
}

async function savePayload(fixtureId, stage, dataType, raw) {
  const payload = Array.isArray(raw?.response) ? raw.response : (raw?.response ?? raw ?? []);
  await query(
    `INSERT INTO prematch_data (fixture_id, stage, data_type, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (fixture_id, stage, data_type) DO UPDATE SET
       payload=EXCLUDED.payload, collected_at=NOW()`,
    [fixtureId, stage, dataType, JSON.stringify(payload)]
  );
}

async function markDone(fixtureId, stage) {
  await query(
    `INSERT INTO prematch_enrichment_log (fixture_id, stage)
     VALUES ($1, $2)
     ON CONFLICT (fixture_id, stage) DO NOTHING`,
    [fixtureId, stage]
  );
}

async function stageIsDone(fixtureId, stage) {
  const r = await query(
    `SELECT 1 FROM prematch_enrichment_log WHERE fixture_id=$1 AND stage=$2`,
    [fixtureId, stage]
  );
  return r.rows.length > 0;
}

async function runStage(fixture, stageNum) {
  const id       = fixture.fixture_id;
  const leagueId = fixture.league_id;
  const homeId   = fixture.home_team_id;
  const awayId   = fixture.away_team_id;
  const season   = new Date().getFullYear();

  const save = async (dt, res) => {
    if (res.status === 'fulfilled') {
      await savePayload(id, stageNum, dt, res.value);
      await sleep(200);
    }
  };

  if (stageNum === 1) {
    const results = await Promise.allSettled([
      apiFetch(`/fixtures?id=${id}`),
      apiFetch(`/venues?league=${leagueId}&season=${season}`),
      apiFetch(`/coaches?team=${homeId}`),
      apiFetch(`/coaches?team=${awayId}`),
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}`),
      apiFetch(`/injuries?fixture=${id}`),
      apiFetch(`/players/squads?team=${homeId}`),
      apiFetch(`/players/squads?team=${awayId}`),
      apiFetch(`/standings?league=${leagueId}&season=${season}`),
    ]);
    const types = ['fixture', 'venues', 'coach_home', 'coach_away', 'h2h', 'injuries', 'squads_home', 'squads_away', 'standings'];
    for (let i = 0; i < types.length; i++) await save(types[i], results[i]);

  } else if (stageNum === 2) {
    const results = await Promise.allSettled([
      apiFetch(`/odds?fixture=${id}`),
      apiFetch(`/fixtures?team=${homeId}&last=10`),
      apiFetch(`/fixtures?team=${awayId}&last=10`),
      apiFetch(`/predictions?fixture=${id}`),
    ]);
    const types = ['odds', 'home_form', 'away_form', 'predictions'];
    for (let i = 0; i < types.length; i++) await save(types[i], results[i]);

  } else if (stageNum === 3) {
    const results = await Promise.allSettled([
      apiFetch(`/odds?fixture=${id}`),
      apiFetch(`/injuries?fixture=${id}`),
      apiFetch(`/fixtures?team=${homeId}&last=10`),
      apiFetch(`/fixtures?team=${awayId}&last=10`),
    ]);
    const types = ['odds', 'injuries', 'home_form', 'away_form'];
    for (let i = 0; i < types.length; i++) await save(types[i], results[i]);

  } else if (stageNum === 4) {
    const results = await Promise.allSettled([
      apiFetch(`/odds?fixture=${id}`),
      apiFetch(`/predictions?fixture=${id}`),
    ]);
    const types = ['odds', 'predictions'];
    for (let i = 0; i < types.length; i++) await save(types[i], results[i]);

  } else if (stageNum === 5 || stageNum === 6) {
    const results = await Promise.allSettled([
      apiFetch(`/fixtures/lineups?fixture=${id}`),
      apiFetch(`/odds?fixture=${id}`),
    ]);
    const types = ['lineups', 'odds'];
    for (let i = 0; i < types.length; i++) await save(types[i], results[i]);

  } else if (stageNum === 7) {
    const results = await Promise.allSettled([
      apiFetch(`/odds?fixture=${id}`),
      apiFetch(`/fixtures/lineups?fixture=${id}`),
      apiFetch(`/injuries?fixture=${id}`),
    ]);
    const types = ['odds', 'lineups', 'injuries'];
    for (let i = 0; i < types.length; i++) await save(types[i], results[i]);
  }

  // Re-captură ARBITRU aproape de kickoff (stage 6: 0.75-1.5h, stage 7: 0-0.5h).
  // La stage 1 (23-25h) arbitrul de obicei nu e încă desemnat → re-fetch /fixtures?id
  // și persistă fixtures.referee + prematch_data['referee_late'] pentru modal/enrich.
  if (stageNum === 6 || stageNum === 7) {
    try {
      const fxData = await apiFetch(`/fixtures?id=${id}`);
      const fxObj  = (fxData.response || [])[0];
      const refRaw = fxObj?.fixture?.referee;
      const ref    = (refRaw && String(refRaw).trim() && refRaw !== 'null') ? String(refRaw).trim() : null;
      if (ref) {
        await query(`UPDATE fixtures SET referee=$1, updated_at=NOW() WHERE fixture_id=$2`, [ref, id]).catch(() => {});
        await savePayload(id, stageNum, 'referee_late', { response: [{ referee: ref, venue: fxObj?.fixture?.venue || null }] });
      }
      await sleep(200);
    } catch (_) { /* non-critical */ }
  }

  await markDone(id, stageNum);
}

export default async function handler(req, res) {
  if (!FOOTBALL_KEY) {
    return res.status(200).json({ error: 'No API key' });
  }

  log('run started');

  try {
    await initTables();

    const now  = new Date();
    const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const fxR = await query(
      `SELECT fixture_id, league_id, home_team_id, away_team_id, match_date
       FROM fixtures
       WHERE status_short = 'NS'
         AND match_date >= $1 AND match_date <= $2
       ORDER BY match_date ASC`,
      [now.toISOString(), in25h.toISOString()]
    );

    const fixtures = fxR.rows;
    log(`${fixtures.length} NS fixtures in next 25h`);

    let executed = 0;
    const results = [];

    for (const fx of fixtures) {
      const kickoff    = new Date(fx.match_date).getTime();
      const hoursUntil = (kickoff - now.getTime()) / 3_600_000;

      for (const s of STAGES) {
        if (hoursUntil >= s.hoursMin && hoursUntil < s.hoursMax) {
          const done = await stageIsDone(fx.fixture_id, s.stage);
          if (!done) {
            log(`fixture ${fx.fixture_id} stage ${s.stage} (${hoursUntil.toFixed(1)}h until kickoff)`);
            try {
              await runStage(fx, s.stage);
              executed++;
              results.push({ fixture_id: fx.fixture_id, stage: s.stage, ok: true });
            } catch (e) {
              log(`fixture ${fx.fixture_id} stage ${s.stage} error: ${e.message}`);
              results.push({ fixture_id: fx.fixture_id, stage: s.stage, ok: false, error: e.message });
            }
          }
          break; // un singur stage activ per meci per rulare
        }
      }

      await sleep(200);
    }

    log(`done: ${executed} stages executed`);

    await query(
      `INSERT INTO cron_logs (job_name, fixtures_processed, status)
       VALUES ($1,$2,'success')`,
      ['prematch-enrichment', executed]
    ).catch(() => {});

    return res.status(200).json({ fixtures: fixtures.length, executed, results });
  } catch (e) {
    log(`ERROR: ${e.message}`);
    await query(
      `INSERT INTO cron_logs (job_name, fixtures_processed, status, error_msg)
       VALUES ($1,0,'error',$2)`,
      ['prematch-enrichment', e.message]
    ).catch(() => {});
    return res.status(200).json({ error: e.message });
  }
}
