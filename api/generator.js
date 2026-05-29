import { query } from './db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { rows } = await query(
      `SELECT p.fixture_id,
              p.home_team,
              p.away_team,
              p.league_id,
              p.league_name,
              p.lambda_home,
              p.lambda_away,
              p.lambda_total,
              p.over15_prob,
              p.over25_prob,
              p.gg_prob,
              p.home_win_prob,
              p.draw_prob,
              p.away_win_prob,
              p.home_score_rate,
              p.away_score_rate,
              p.h2h_over15,
              p.confidence,
              p.best_ev,
              p.best_cota,
              p.best_bet,
              f.match_date,
              f.status_short,
              f.home_team_name,
              f.away_team_name,
              f.league_id    AS fixture_league_id,
              f.home_team_id,
              f.away_team_id
         FROM predictions p
         JOIN fixtures f ON f.fixture_id = p.fixture_id
        WHERE f.status_short = 'NS'
          AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '36 hours'
          AND p.confidence  >= 70
          AND p.over15_prob >= 70
        ORDER BY p.confidence DESC
        LIMIT 10`
    );

    const logoBase = 'https://media.api-sports.io/football/teams/';

    const matches = rows.map(r => {
      const hid  = r.home_team_id;
      const aid  = r.away_team_id;
      const lid  = r.league_id || r.fixture_league_id;
      const home = r.home_team || r.home_team_name || '?';
      const away = r.away_team || r.away_team_name || '?';

      const markets = {
        over15:      { prob: +(r.over15_prob)   || 0, label: 'Over 1.5' },
        over25:      { prob: +(r.over25_prob)   || 0, label: 'Over 2.5' },
        gg:          { prob: +(r.gg_prob)       || 0, label: 'GG (Ambele marchează)' },
        home_scores: { prob: +(r.home_score_rate) || 0, label: 'Gazde marchează' },
        away_scores: { prob: +(r.away_score_rate) || 0, label: 'Oaspeți marchează' },
        h1:          { prob: +(r.home_win_prob) || 0, label: '1 (Victorie Gazde)' },
        draw:        { prob: +(r.draw_prob)     || 0, label: 'X (Egal)' },
        h2:          { prob: +(r.away_win_prob) || 0, label: '2 (Victorie Oaspeți)' },
      };

      return {
        fixture_id:      r.fixture_id,
        home_team:       home,
        away_team:       away,
        home_logo:       hid ? `${logoBase}${hid}.png` : null,
        away_logo:       aid ? `${logoBase}${aid}.png` : null,
        league_id:       lid,
        league_name:     r.league_name || '',
        league_country:  '',
        match_date:      r.match_date,
        status_short:    r.status_short || 'NS',
        is_live:         false,
        minute:          0,
        home_goals:      0,
        away_goals:      0,
        lambda_home:     +(r.lambda_home)  || null,
        lambda_away:     +(r.lambda_away)  || null,
        lambda_total:    +(r.lambda_total) || null,
        confidence:      +(r.confidence)   || 0,
        best_ev:         r.best_ev   != null ? +(r.best_ev)   : null,
        best_cota:       r.best_cota != null ? +(r.best_cota) : null,
        best_bet:        r.best_bet  || null,
        h2h_over15:      r.h2h_over15 != null ? +(r.h2h_over15) : null,
        markets,
      };
    });

    return res.json({ ok: true, mode: 'prematch', count: matches.length, matches });
  } catch (e) {
    console.error('[generator]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
