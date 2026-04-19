export default async function handler(req, res) {
  const fdKey = process.env.FOOTBALL_DATA_KEY;
  const afKey = process.env.API_FOOTBALL_KEY;
  const combined = [];

  // football-data.org - real-time, top 12 competitions
  if (fdKey) {
    try {
      const r = await fetch('https://api.football-data.org/v4/matches?status=LIVE', {
        headers: { 'X-Auth-Token': fdKey }
      });
      const data = await r.json();
      if (!data.errorCode && Array.isArray(data.matches)) {
        data.matches.forEach(m => {
          combined.push({
            _src: 'fd',
            fixture: { status: { elapsed: m.minute || 0 } },
            league: { id: m.competition.id, name: m.competition.name, f: m.competition.code || '?' },
            teams: {
              home: { name: m.homeTeam.shortName || m.homeTeam.name },
              away: { name: m.awayTeam.shortName || m.awayTeam.name }
            },
            goals: {
              home: m.score.fullTime.home !== null ? m.score.fullTime.home : 0,
              away: m.score.fullTime.away !== null ? m.score.fullTime.away : 0
            },
            statistics: []
          });
        });
      }
    } catch (e) {}
  }

  // api-sports.io - 88 leagues (with delay for free tier)
  if (afKey) {
    try {
      const r = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
        headers: { 'x-apisports-key': afKey }
      });
      const data = await r.json();
      if (Array.isArray(data.response)) {
        // Add only matches not already covered by football-data.org
        const fdNames = new Set(combined.map(m => m.teams.home.name + '|' + m.teams.away.name));
        data.response.forEach(m => {
          const key = (m.teams?.home?.name || '') + '|' + (m.teams?.away?.name || '');
          if (!fdNames.has(key)) combined.push(m);
        });
      }
    } catch (e) {}
  }

  res.status(200).json({ response: combined });
}
