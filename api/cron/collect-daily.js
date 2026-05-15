// api/cron/collect-daily.js
// Rulează zilnic la 06:00
// Colectează: standings, leagues, teams pentru top 5 ligi europene
// Limitat la 5 ligi + budget de 8s pentru a nu depăși timeout-ul Vercel de 10s

const PRIORITY_LEAGUES = [
  39, 140, 135, 78, 61,   // PL, LaLiga, SerieA, Bundesliga, Ligue1
];

const SEASON = new Date().getFullYear();

async function fetchAPI(endpoint, key) {
  const res = await fetch(`https://v3.football.api-sports.io${endpoint}`, {
    headers: { 'x-apisports-key': key },
  });
  const data = await res.json();
  return data.response || [];
}

async function sbUpsert(sbUrl, sbKey, table, onConflict, rows) {
  if (!rows.length) return;
  await fetch(`${sbUrl}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      'apikey':        sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
}

async function logCron(sbUrl, sbKey, stats, status, errorMsg) {
  try {
    await fetch(`${sbUrl}/rest/v1/cron_logs`, {
      method: 'POST',
      headers: {
        'apikey':        sbKey,
        'Authorization': `Bearer ${sbKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        job_name:           'collect-daily',
        fixtures_processed: stats.standings,
        players_upserted:   stats.teams,
        status,
        error_msg:          errorMsg,
      }),
    });
  } catch (_) {}
}

export default async function handler(req, res) {
  const key   = process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;

  if (!key || !sbUrl || !sbKey)
    return res.status(500).json({ error: 'Environment vars lipsa' });

  const startTime = Date.now();
  const stats = { leagues: 0, teams: 0, standings: 0, errors: [] };

  try {
    for (const leagueId of PRIORITY_LEAGUES) {
      // Time budget: stop if we're past 8 seconds to avoid Vercel's 10s timeout
      if (Date.now() - startTime > 8000) break;

      try {
        const standings = await fetchAPI(`/standings?league=${leagueId}&season=${SEASON}`, key);
        if (!standings.length) continue;

        const league = standings[0]?.league;
        if (league) {
          await sbUpsert(sbUrl, sbKey, 'leagues', 'id', [{
            id:         league.id,
            name:       league.name,
            country:    league.country,
            logo:       league.logo,
            season:     SEASON,
            active:     true,
            updated_at: new Date().toISOString(),
          }]);
          stats.leagues++;
        }

        const rows = standings[0]?.league?.standings?.[0] || [];
        const standingRows = [];
        const teamRows = [];

        for (const row of rows) {
          standingRows.push({
            league_id:     leagueId,
            season:        SEASON,
            team_id:       row.team.id,
            team_name:     row.team.name,
            rank:          row.rank,
            points:        row.points,
            goals_for:     row.all?.goals?.for   || 0,
            goals_against: row.all?.goals?.against || 0,
            goal_diff:     row.goalsDiff,
            played:        row.all?.played || 0,
            won:           row.all?.win    || 0,
            drawn:         row.all?.draw   || 0,
            lost:          row.all?.lose   || 0,
            form:          row.form || null,
            updated_at:    new Date().toISOString(),
          });
          teamRows.push({
            id:         row.team.id,
            name:       row.team.name,
            logo:       row.team.logo,
            league_id:  leagueId,
            updated_at: new Date().toISOString(),
          });
          stats.standings++;
          stats.teams++;
        }

        // Batch upsert — o singură cerere per ligă în loc de una per echipă
        await sbUpsert(sbUrl, sbKey, 'standings', 'league_id,season,team_id', standingRows);
        await sbUpsert(sbUrl, sbKey, 'teams', 'id', teamRows);
      } catch (e) {
        stats.errors.push(`league ${leagueId}: ${e.message}`);
      }
    }

    await logCron(sbUrl, sbKey, stats, 'success', stats.errors.length ? stats.errors.join('; ') : null);

    return res.status(200).json({
      success:     true,
      duration_ms: Date.now() - startTime,
      stats,
    });
  } catch (error) {
    await logCron(sbUrl, sbKey, stats, 'error', error.message);
    return res.status(500).json({ error: error.message });
  }
}
