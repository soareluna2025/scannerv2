// api/cron/coach-stats.js
// Statistici per antrenor: FAZA 1 (DB) + FAZA 2 (API)
// Rulează zilnic la 04:00

import { query } from '../db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function calcStyle(avgTotal, avgYC, pctCS) {
  if (avgTotal >= 3.0) return 'offensive';
  if (avgTotal <= 1.8) return 'defensive';
  if (avgYC    >= 4.5) return 'aggressive';
  if (pctCS    >= 40)  return 'solid';
  return 'balanced';
}

async function upsertCoach(coachId, coachName, teamId, acc) {
  const { m, w, draws, scored, conceded, total,
          o05, o15, o25, gg, cs,
          yc, rc, corners, fouls,
          homeG, homeM, awayG, awayM } = acc;

  if (m < 10) return false;

  const r2 = v => Math.round(v * 100) / 100;
  const winRate   = r2(w     / m * 100);
  const drawRate  = r2(draws / m * 100);
  const lossRate  = r2(Math.max(0, 100 - winRate - drawRate));
  const avgTotal  = r2(total / m);
  const avgYC     = r2(yc    / m);
  const pctCS     = r2(cs    / m * 100);
  const style     = calcStyle(avgTotal, avgYC, pctCS);

  await query(`
    INSERT INTO coach_stats
      (coach_id, coach_name, team_id, total_matches,
       avg_goals_scored, avg_goals_conceded, avg_total_goals,
       pct_over_05, pct_over_15, pct_over_25, pct_gg, pct_clean_sheet,
       avg_yellow_cards, avg_red_cards, avg_corners, avg_fouls,
       win_rate, draw_rate, loss_rate,
       home_avg_goals, away_avg_goals,
       coach_style, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
    ON CONFLICT (coach_id) DO UPDATE SET
      coach_name         = EXCLUDED.coach_name,
      team_id            = EXCLUDED.team_id,
      total_matches      = EXCLUDED.total_matches,
      avg_goals_scored   = EXCLUDED.avg_goals_scored,
      avg_goals_conceded = EXCLUDED.avg_goals_conceded,
      avg_total_goals    = EXCLUDED.avg_total_goals,
      pct_over_05        = EXCLUDED.pct_over_05,
      pct_over_15        = EXCLUDED.pct_over_15,
      pct_over_25        = EXCLUDED.pct_over_25,
      pct_gg             = EXCLUDED.pct_gg,
      pct_clean_sheet    = EXCLUDED.pct_clean_sheet,
      avg_yellow_cards   = EXCLUDED.avg_yellow_cards,
      avg_red_cards      = EXCLUDED.avg_red_cards,
      avg_corners        = EXCLUDED.avg_corners,
      avg_fouls          = EXCLUDED.avg_fouls,
      win_rate           = EXCLUDED.win_rate,
      draw_rate          = EXCLUDED.draw_rate,
      loss_rate          = EXCLUDED.loss_rate,
      home_avg_goals     = EXCLUDED.home_avg_goals,
      away_avg_goals     = EXCLUDED.away_avg_goals,
      coach_style        = EXCLUDED.coach_style,
      updated_at         = NOW()
  `, [
    coachId, coachName, teamId, m,
    r2(scored / m), r2(conceded / m), avgTotal,
    r2(o05 / m * 100), r2(o15 / m * 100), r2(o25 / m * 100),
    r2(gg  / m * 100), pctCS,
    avgYC, r2(rc / m), r2(corners / m), r2(fouls / m),
    winRate, drawRate, lossRate,
    homeM > 0 ? r2(homeG / homeM) : 0,
    awayM > 0 ? r2(awayG / awayM) : 0,
    style,
  ]);
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const hdr   = { 'x-apisports-key': key };
  const start = Date.now();

  try {
    // ── Creare tabel + coloane noi (idempotent) ───────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS coach_stats (
        coach_id           INTEGER PRIMARY KEY,
        coach_name         VARCHAR(200),
        team_id            INTEGER,
        total_matches      INTEGER DEFAULT 0,
        avg_goals_scored   DECIMAL(4,2) DEFAULT 0,
        avg_goals_conceded DECIMAL(4,2) DEFAULT 0,
        avg_total_goals    DECIMAL(4,2) DEFAULT 0,
        pct_over_05        DECIMAL(5,2) DEFAULT 0,
        pct_over_15        DECIMAL(5,2) DEFAULT 0,
        pct_over_25        DECIMAL(5,2) DEFAULT 0,
        pct_gg             DECIMAL(5,2) DEFAULT 0,
        pct_clean_sheet    DECIMAL(5,2) DEFAULT 0,
        avg_yellow_cards   DECIMAL(4,2) DEFAULT 0,
        avg_red_cards      DECIMAL(4,2) DEFAULT 0,
        avg_corners        DECIMAL(4,2) DEFAULT 0,
        avg_fouls          DECIMAL(4,2) DEFAULT 0,
        win_rate           DECIMAL(5,2) DEFAULT 0,
        draw_rate          DECIMAL(5,2) DEFAULT 0,
        loss_rate          DECIMAL(5,2) DEFAULT 0,
        home_avg_goals     DECIMAL(4,2) DEFAULT 0,
        away_avg_goals     DECIMAL(4,2) DEFAULT 0,
        coach_style        VARCHAR(20) DEFAULT 'balanced',
        updated_at         TIMESTAMP DEFAULT NOW()
      )
    `);
    await query(`ALTER TABLE fixtures_history ADD COLUMN IF NOT EXISTS home_coach     TEXT`);
    await query(`ALTER TABLE fixtures_history ADD COLUMN IF NOT EXISTS away_coach     TEXT`);
    await query(`ALTER TABLE fixtures_history ADD COLUMN IF NOT EXISTS home_coach_id  INTEGER`);
    await query(`ALTER TABLE fixtures_history ADD COLUMN IF NOT EXISTS away_coach_id  INTEGER`);

    // ── FAZA 1 — Agregare din DB (instant) ───────────────────────────────
    // Subquery match_stats: carduri + cornere per fixture
    const msSubQ = `
      SELECT fixture_id,
        SUM(COALESCE(yellow_cards,0)) AS yc,
        SUM(COALESCE(red_cards,0))    AS rc,
        SUM(COALESCE(corner_kicks,0)) AS corners,
        SUM(COALESCE(fouls,0))        AS fouls
      FROM match_stats
      GROUP BY fixture_id
    `;

    const dbCoachMap = new Map();

    const runDBPhase = async (side) => {
      const coachIdCol   = side === 'home' ? 'home_coach_id'   : 'away_coach_id';
      const coachNameCol = side === 'home' ? 'home_coach'       : 'away_coach';
      const teamIdCol    = side === 'home' ? 'home_team_id'     : 'away_team_id';
      const scoredCol    = side === 'home' ? 'home_goals'       : 'away_goals';
      const concededCol  = side === 'home' ? 'away_goals'       : 'home_goals';
      const winCond      = side === 'home' ? 'fh.home_goals > fh.away_goals' : 'fh.away_goals > fh.home_goals';
      const csCond       = side === 'home' ? 'fh.away_goals = 0' : 'fh.home_goals = 0';

      const { rows } = await query(`
        SELECT
          fh.${coachIdCol}                                                                    AS coach_id,
          fh.${coachNameCol}                                                                  AS coach_name,
          fh.${teamIdCol}                                                                     AS team_id,
          COUNT(*)                                                                            AS matches,
          SUM(CASE WHEN ${winCond} THEN 1 ELSE 0 END)                                        AS wins,
          SUM(CASE WHEN fh.home_goals = fh.away_goals THEN 1 ELSE 0 END)                     AS draws,
          SUM(fh.${scoredCol})::NUMERIC(10,2)                                                 AS sum_scored,
          SUM(fh.${concededCol})::NUMERIC(10,2)                                               AS sum_conceded,
          SUM(fh.home_goals + fh.away_goals)::NUMERIC(10,2)                                  AS sum_total,
          COUNT(*) FILTER (WHERE fh.home_goals + fh.away_goals >= 1)                         AS cnt_o05,
          COUNT(*) FILTER (WHERE fh.home_goals + fh.away_goals >= 2)                         AS cnt_o15,
          COUNT(*) FILTER (WHERE fh.home_goals + fh.away_goals >= 3)                         AS cnt_o25,
          COUNT(*) FILTER (WHERE fh.home_goals > 0 AND fh.away_goals > 0)                    AS cnt_gg,
          COUNT(*) FILTER (WHERE ${csCond})                                                   AS cnt_cs,
          COALESCE(SUM(ms.yc),0)::NUMERIC(10,2)                                              AS sum_yc,
          COALESCE(SUM(ms.rc),0)::NUMERIC(10,2)                                              AS sum_rc,
          COALESCE(SUM(ms.corners),0)::NUMERIC(10,2)                                         AS sum_corners,
          COALESCE(SUM(ms.fouls),0)::NUMERIC(10,2)                                           AS sum_fouls,
          SUM(CASE WHEN fh.${scoredCol} IS NOT NULL THEN fh.${scoredCol} ELSE 0 END)
            FILTER (WHERE fh.${side}_team_id IS NOT NULL)::NUMERIC(10,2)                     AS home_g,
          COUNT(*) FILTER (WHERE fh.${side}_team_id IS NOT NULL)                             AS home_m,
          SUM(CASE WHEN fh.${scoredCol} IS NOT NULL THEN fh.${scoredCol} ELSE 0 END)
            FILTER (WHERE fh.${side}_team_id IS NULL)::NUMERIC(10,2)                         AS away_g,
          COUNT(*) FILTER (WHERE fh.${side}_team_id IS NULL)                                 AS away_m
        FROM fixtures_history fh
        LEFT JOIN (${msSubQ}) ms ON ms.fixture_id = fh.fixture_id
        WHERE fh.${coachIdCol} IS NOT NULL
          AND fh.season >= 2024
          AND fh.status_short = 'FT'
          AND fh.home_goals IS NOT NULL
          AND fh.away_goals IS NOT NULL
        GROUP BY fh.${coachIdCol}, fh.${coachNameCol}, fh.${teamIdCol}
        HAVING COUNT(*) >= 5
      `).catch(() => ({ rows: [] }));

      for (const row of rows) {
        const id = parseInt(row.coach_id);
        if (!id) continue;
        const m  = parseInt(row.matches) || 0;
        const e  = dbCoachMap.get(id) || {
          coach_name: row.coach_name, team_id: parseInt(row.team_id) || null,
          m: 0, w: 0, draws: 0, scored: 0, conceded: 0, total: 0,
          o05: 0, o15: 0, o25: 0, gg: 0, cs: 0,
          yc: 0, rc: 0, corners: 0, fouls: 0,
          homeG: 0, homeM: 0, awayG: 0, awayM: 0,
        };
        dbCoachMap.set(id, {
          ...e,
          m:       e.m       + m,
          w:       e.w       + (parseInt(row.wins)  || 0),
          draws:   e.draws   + (parseInt(row.draws) || 0),
          scored:  e.scored  + (parseFloat(row.sum_scored)   || 0),
          conceded:e.conceded+ (parseFloat(row.sum_conceded) || 0),
          total:   e.total   + (parseFloat(row.sum_total)    || 0),
          o05:     e.o05     + (parseInt(row.cnt_o05) || 0),
          o15:     e.o15     + (parseInt(row.cnt_o15) || 0),
          o25:     e.o25     + (parseInt(row.cnt_o25) || 0),
          gg:      e.gg      + (parseInt(row.cnt_gg)  || 0),
          cs:      e.cs      + (parseInt(row.cnt_cs)  || 0),
          yc:      e.yc      + (parseFloat(row.sum_yc)      || 0),
          rc:      e.rc      + (parseFloat(row.sum_rc)      || 0),
          corners: e.corners + (parseFloat(row.sum_corners) || 0),
          fouls:   e.fouls   + (parseFloat(row.sum_fouls)   || 0),
          homeG:   e.homeG   + (parseFloat(row.home_g) || 0),
          homeM:   e.homeM   + (parseInt(row.home_m)  || 0),
          awayG:   e.awayG   + (parseFloat(row.away_g) || 0),
          awayM:   e.awayM   + (parseInt(row.away_m)  || 0),
        });
      }
    };

    await runDBPhase('home');
    await runDBPhase('away');

    let dbUpserted = 0;
    for (const [coachId, acc] of dbCoachMap) {
      if (await upsertCoach(coachId, acc.coach_name, acc.team_id, acc)) dbUpserted++;
    }

    // ── FAZA 2 — Din API (completare) ────────────────────────────────────
    // Citește toate team_id distincte din ultimele 2 sezoane
    const { rows: teamRows } = await query(`
      SELECT DISTINCT home_team_id AS tid FROM fixtures_history WHERE season >= 2024 AND home_team_id IS NOT NULL
      UNION
      SELECT DISTINCT away_team_id          FROM fixtures_history WHERE season >= 2024 AND away_team_id IS NOT NULL
    `).catch(() => ({ rows: [] }));

    const teamIds = teamRows.map(r => parseInt(r.tid)).filter(Boolean);
    const coachesSeen = new Set();
    let apiUpserted = 0;

    for (const teamId of teamIds) {
      if (coachesSeen.size >= 100) break;

      try {
        const r    = await fetch(`https://v3.football.api-sports.io/coachs?team=${teamId}`, { headers: hdr });
        const data = await r.json();
        const coaches = data.response || [];
        await sleep(300);

        for (const coach of coaches) {
          const coachId   = coach.id;
          const coachName = coach.name;
          if (!coachId || coachesSeen.has(coachId)) continue;
          coachesSeen.add(coachId);

          // Backfill coach_id în fixtures_history pentru echipa curentă
          await query(`
            UPDATE fixtures_history
            SET home_coach_id = $1, home_coach = $2
            WHERE home_team_id = $3 AND season >= 2024 AND home_coach_id IS NULL
          `, [coachId, coachName, teamId]).catch(() => {});
          await query(`
            UPDATE fixtures_history
            SET away_coach_id = $1, away_coach = $2
            WHERE away_team_id = $3 AND season >= 2024 AND away_coach_id IS NULL
          `, [coachId, coachName, teamId]).catch(() => {});

          // Skip dacă există deja date suficiente
          const { rows: ex } = await query(
            'SELECT total_matches FROM coach_stats WHERE coach_id = $1', [coachId]
          ).catch(() => ({ rows: [] }));
          if ((ex[0]?.total_matches || 0) >= 10) continue;

          // Fetch fixtures pentru sezonul 2024 și 2025
          const seasons = ['2024', '2025'];
          const allFix = [];
          for (const season of seasons) {
            try {
              const rf   = await fetch(
                `https://v3.football.api-sports.io/fixtures?coach=${coachId}&season=${season}`,
                { headers: hdr }
              );
              const fd   = await rf.json();
              allFix.push(...(fd.response || []));
              await sleep(300);
            } catch (_) { await sleep(300); }
          }

          const finished = allFix.filter(f =>
            f.fixture?.status?.short === 'FT' &&
            f.goals?.home != null &&
            f.goals?.away != null
          );
          if (finished.length < 10) continue;

          const acc = { m: 0, w: 0, draws: 0, scored: 0, conceded: 0, total: 0,
                        o05: 0, o15: 0, o25: 0, gg: 0, cs: 0,
                        yc: 0, rc: 0, corners: 0, fouls: 0,
                        homeG: 0, homeM: 0, awayG: 0, awayM: 0 };

          for (const fix of finished) {
            const isHome  = fix.teams?.home?.id === teamId;
            const scored  = isHome ? (fix.goals?.home ?? 0) : (fix.goals?.away ?? 0);
            const conceded= isHome ? (fix.goals?.away ?? 0) : (fix.goals?.home ?? 0);
            const tot     = scored + conceded;
            acc.m++;
            if (scored > conceded) acc.w++;
            if (scored === conceded) acc.draws++;
            acc.scored   += scored;
            acc.conceded += conceded;
            acc.total    += tot;
            if (tot >= 1) acc.o05++;
            if (tot >= 2) acc.o15++;
            if (tot >= 3) acc.o25++;
            if (scored > 0 && conceded > 0) acc.gg++;
            if (conceded === 0) acc.cs++;
            if (isHome) { acc.homeG += scored; acc.homeM++; }
            else        { acc.awayG += scored; acc.awayM++; }
          }

          if (await upsertCoach(coachId, coachName, teamId, acc)) apiUpserted++;
        }
      } catch (_) { await sleep(300); }
    }

    return res.status(200).json({
      ok:           true,
      duration_ms:  Date.now() - start,
      db_upserted:  dbUpserted,
      api_upserted: apiUpserted,
      coaches_seen: coachesSeen.size,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
