export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'FOOTBALL_DATA_KEY not configured' });

  try {
    const r = await fetch('https://api.football-data.org/v4/matches?status=LIVE', {
      headers: { 'X-Auth-Token': key }
    });
    const data = await r.json();
    if (data.errorCode) return res.status(401).json({ error: data.message || 'API key invalid' });

    const matches = (data.matches || []).map(m => ({
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
    }));

    res.status(200).json({ response: matches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
