// api/cron/collect-daily.js
// Rulează zilnic la 06:00
// Colectează: fixtures, teams, standings, leagues, injuries

const PRIORITY_LEAGUES = [
  39, 140, 135, 78, 61,   // PL, LaLiga, SerieA, Bundesliga, Ligue1
  2, 3, 848,              // UCL, UEL, UECL
  94, 88, 144, 203,       // Primeira, Eredivisie, Jupiler, SuperLig
  71, 128, 253,           // Brazil, Argentina, MLS
  197, 169, 262,          // SuperLeague, Liga1, Liga MX
];

const SEASON = new Date().getFullYear();

async function fetchAPI(endpoint, key) {
  const res = await fetch(`https://v3.football.api-sports.io${endpoint}`, {
    headers: { 'x-apisports-key': key },
  });
  const data = await res.json();
  return data.response || [];
}

async function sbPost(sbUrl, sbKey, path, body) {
  await fetch(`${sbUrl}/rest/v1${path}`, {
    method: 'POST',
    headers: {
      'apikey':        sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        fixtures_processed: stats.fixtures,
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
  const stats = { leagues: 0, teams: 0, fixtures: 0, standings: 0, injuries: 0, errors: [] };

  try {
    // ============================================
    // 1. FIXTURES AZI + MÂINE
    // ============================================
    const today    = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    for (const date of [today, tomorrow]) {
      try {
        const fixtures = await fetchAPI(`/fixtures?date=${date}&status=NS-1H-HT-2H`, key);
        for (const f of fixtures) {
          await sbPost(sbUrl, sbKey, '/fixtures?on_conflict=id', {
            id:             f.fixture.id,
            league_id:      f.league.id,
            season:         f.league.season,
            home_team_id:   f.teams.home.id,
            away_team_id:   f.teams.away.id,
            home_team_name: f.teams.home.name,
            away_team_name: f.teams.away.name,
            kickoff_time:   f.fixture.date,
            status_short:   f.fixture.status.short,
            status_long:    f.fixture.status.long,
            venue:          f.fixture.venue?.name || null,
            referee:        f.fixture.referee || null,
            updated_at:     new Date().toISOString(),
          });

          for (const team of [f.teams.home, f.teams.away]) {
            await sbPost(sbUrl, sbKey, '/teams?on_conflict=id', {
              id:         team.id,
              name:       team.name,
              logo:       team.logo,
              updated_at: new Date().toISOString(),
            });
            stats.teams++;
          }
          stats.fixtures++;
        }
      } catch (e) {
        stats.errors.push(`fixtures ${date}: ${e.message}`);
      }
    }

    // ============================================
    // 2. STANDINGS + LEAGUES + TEAMS
    // ============================================
    for (const leagueId of PRIORITY_LEAGUES) {
      try {
        const standings = await fetchAPI(`/standings?league=${leagueId}&season=${SEASON}`, key);
        if (!standings.length) continue;

        const league = standings[0]?.league;
        if (league) {
          await sbPost(sbUrl, sbKey, '/leagues?on_conflict=id', {
            id:         league.id,
            name:       league.name,
            country:    league.country,
            logo:       league.logo,
            season:     SEASON,
            active:     true,
            updated_at: new Date().toISOString(),
          });
          stats.leagues++;
        }

        const rows = standings[0]?.league?.standings?.[0] || [];
        for (const row of rows) {
          await sbPost(sbUrl, sbKey, '/standings?on_conflict=league_id,season,team_id', {
            league_id:     leagueId,
            season:        SEASON,
            team_id:       row.team.id,
            team_name:     row.team.name,
            rank:          row.rank,
            points:        row.points,
            goals_for:     row.all.goals.for,
            goals_against: row.all.goals.against,
            goal_diff:     row.goalsDiff,
            played:        row.all.played,
            won:           row.all.win,
            drawn:         row.all.draw,
            lost:          row.all.lose,
            form:          row.form,
            home_played:   row.home.played,
            away_played:   row.away.played,
            updated_at:    new Date().toISOString(),
          });

          await sbPost(sbUrl, sbKey, '/teams?on_conflict=id', {
            id:         row.team.id,
            name:       row.team.name,
            logo:       row.team.logo,
            league_id:  leagueId,
            updated_at: new Date().toISOString(),
          });

          stats.standings++;
          stats.teams++;
        }
      } catch (e) {
        stats.errors.push(`standings league ${leagueId}: ${e.message}`);
      }
      await sleep(100);
    }

    // ============================================
    // 3. INJURIES PENTRU MECIURILE DE AZI
    // ============================================
    try {
      const todayFixtures = await fetchAPI(`/fixtures?date=${today}&status=NS`, key);
      for (const f of todayFixtures.slice(0, 30)) {
        try {
          const injuries = await fetchAPI(`/injuries?fixture=${f.fixture.id}`, key);
          for (const inj of injuries) {
            await sbPost(sbUrl, sbKey, '/injuries?on_conflict=player_id,fixture_id', {
              player_id:     inj.player.id,
              team_id:       inj.team.id,
              league_id:     f.league.id,
              fixture_id:    f.fixture.id,
              player_name:   inj.player.name,
              injury_type:   inj.player.type,
              injury_reason: inj.player.reason,
              match_date:    f.fixture.date,
              active:        true,
              updated_at:    new Date().toISOString(),
            });
            stats.injuries++;
          }
        } catch (_) {}
        await sleep(150);
      }
    } catch (e) {
      stats.errors.push(`injuries: ${e.message}`);
    }

    await logCron(sbUrl, sbKey, stats, 'success', null);

    return res.status(200).json({
      success: true,
      duration_ms: Date.now() - startTime,
      stats,
    });

  } catch (error) {
    await logCron(sbUrl, sbKey, stats, 'error', error.message);
    return res.status(500).json({ error: error.message });
  }
}
