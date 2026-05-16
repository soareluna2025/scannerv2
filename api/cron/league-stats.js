// api/cron/league-stats.js
// Calculează statistici per ligă din fixtures_history și match_stats
// Rulează zilnic la 04:00 — zero apeluri API, calcul local din DB

import { query } from '../db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const start = Date.now();

  try {
    // Crează tabelul dacă nu există
    await query(`
      CREATE TABLE IF NOT EXISTS league_stats (
        league_id            INTEGER PRIMARY KEY,
        league_name          VARCHAR(200),
        season               INTEGER,
        total_matches        INTEGER DEFAULT 0,
        avg_goals_per_match  DECIMAL(4,2) DEFAULT 0,
        avg_home_goals       DECIMAL(4,2) DEFAULT 0,
        avg_away_goals       DECIMAL(4,2) DEFAULT 0,
        pct_over_05          DECIMAL(5,2) DEFAULT 0,
        pct_over_15          DECIMAL(5,2) DEFAULT 0,
        pct_over_25          DECIMAL(5,2) DEFAULT 0,
        pct_over_35          DECIMAL(5,2) DEFAULT 0,
        pct_gg               DECIMAL(5,2) DEFAULT 0,
        pct_btts             DECIMAL(5,2) DEFAULT 0,
        avg_yellow_cards     DECIMAL(4,2) DEFAULT 0,
        avg_red_cards        DECIMAL(4,2) DEFAULT 0,
        avg_corners          DECIMAL(4,2) DEFAULT 0,
        league_type          VARCHAR(20) DEFAULT 'balanced',
        updated_at           TIMESTAMP DEFAULT NOW()
      )
    `);

    // Calculează statistici goluri din fixtures_history (ultimele 2 sezoane)
    const { rows: goalRows } = await query(`
      SELECT
        league_id,
        COUNT(*) AS total_matches,
        AVG(home_goals + away_goals)::NUMERIC(5,2)                                    AS avg_goals_per_match,
        AVG(home_goals)::NUMERIC(5,2)                                                 AS avg_home_goals,
        AVG(away_goals)::NUMERIC(5,2)                                                 AS avg_away_goals,
        (100.0 * COUNT(*) FILTER (WHERE home_goals + away_goals >= 1) / COUNT(*))::NUMERIC(5,2) AS pct_over_05,
        (100.0 * COUNT(*) FILTER (WHERE home_goals + away_goals >= 2) / COUNT(*))::NUMERIC(5,2) AS pct_over_15,
        (100.0 * COUNT(*) FILTER (WHERE home_goals + away_goals >= 3) / COUNT(*))::NUMERIC(5,2) AS pct_over_25,
        (100.0 * COUNT(*) FILTER (WHERE home_goals + away_goals >= 4) / COUNT(*))::NUMERIC(5,2) AS pct_over_35,
        (100.0 * COUNT(*) FILTER (WHERE home_goals > 0 AND away_goals > 0) / COUNT(*))::NUMERIC(5,2) AS pct_gg
      FROM fixtures_history
      WHERE season >= 2024
        AND status_short = 'FT'
        AND home_goals IS NOT NULL
        AND away_goals IS NOT NULL
      GROUP BY league_id
      HAVING COUNT(*) >= 10
    `);

    // Calculează statistici carduri/cornere din match_stats (SUM per meci, AVG per ligă)
    const { rows: cardRows } = await query(`
      SELECT
        fh.league_id,
        AVG(pm.match_yc)::NUMERIC(4,2)      AS avg_yellow,
        AVG(pm.match_rc)::NUMERIC(4,2)      AS avg_red,
        AVG(pm.match_corners)::NUMERIC(4,2) AS avg_corners
      FROM (
        SELECT fixture_id,
          SUM(COALESCE(yellow_cards, 0)) AS match_yc,
          SUM(COALESCE(red_cards, 0))    AS match_rc,
          SUM(COALESCE(corner_kicks, 0)) AS match_corners
        FROM match_stats
        GROUP BY fixture_id
      ) pm
      JOIN fixtures_history fh ON fh.fixture_id = pm.fixture_id
      WHERE fh.season >= 2024
      GROUP BY fh.league_id
    `).catch(() => ({ rows: [] }));

    // Citește numele ligilor
    const { rows: lgRows } = await query('SELECT league_id, name FROM leagues').catch(() => ({ rows: [] }));
    const nameMap = Object.fromEntries(lgRows.map(r => [Number(r.league_id), r.name]));
    const cardMap = Object.fromEntries(cardRows.map(r => [Number(r.league_id), r]));

    let upserted = 0;
    for (const row of goalRows) {
      const lid       = Number(row.league_id);
      const avgGoals  = parseFloat(row.avg_goals_per_match) || 0;
      const avgYellow = parseFloat(cardMap[lid]?.avg_yellow) || 0;

      let leagueType = 'balanced';
      if (avgGoals >= 3.0)       leagueType = 'open';
      else if (avgGoals <= 2.0)  leagueType = 'closed';
      else if (avgYellow >= 4.5) leagueType = 'aggressive';

      await query(`
        INSERT INTO league_stats
          (league_id, league_name, season, total_matches,
           avg_goals_per_match, avg_home_goals, avg_away_goals,
           pct_over_05, pct_over_15, pct_over_25, pct_over_35,
           pct_gg, pct_btts,
           avg_yellow_cards, avg_red_cards, avg_corners,
           league_type, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
        ON CONFLICT (league_id) DO UPDATE SET
          league_name=EXCLUDED.league_name, season=EXCLUDED.season,
          total_matches=EXCLUDED.total_matches,
          avg_goals_per_match=EXCLUDED.avg_goals_per_match,
          avg_home_goals=EXCLUDED.avg_home_goals,
          avg_away_goals=EXCLUDED.avg_away_goals,
          pct_over_05=EXCLUDED.pct_over_05, pct_over_15=EXCLUDED.pct_over_15,
          pct_over_25=EXCLUDED.pct_over_25, pct_over_35=EXCLUDED.pct_over_35,
          pct_gg=EXCLUDED.pct_gg, pct_btts=EXCLUDED.pct_btts,
          avg_yellow_cards=EXCLUDED.avg_yellow_cards,
          avg_red_cards=EXCLUDED.avg_red_cards,
          avg_corners=EXCLUDED.avg_corners,
          league_type=EXCLUDED.league_type,
          updated_at=NOW()
      `, [
        lid,
        nameMap[lid] || null,
        2025,
        parseInt(row.total_matches),
        row.avg_goals_per_match,
        row.avg_home_goals,
        row.avg_away_goals,
        row.pct_over_05,
        row.pct_over_15,
        row.pct_over_25,
        row.pct_over_35,
        row.pct_gg,
        row.pct_gg, // pct_btts = pct_gg (ambele marchează = both teams to score)
        cardMap[lid]?.avg_yellow || 0,
        cardMap[lid]?.avg_red    || 0,
        cardMap[lid]?.avg_corners || 0,
        leagueType,
      ]);
      upserted++;
    }

    return res.status(200).json({
      ok:                true,
      duration_ms:       Date.now() - start,
      leagues_processed: upserted,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
