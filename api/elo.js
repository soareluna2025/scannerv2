const K = 32;

function getOrSet(map, id) {
  if (!map.has(id)) map.set(id, 1500);
  return map.get(id);
}

export function calcElo(homeMatches, awayMatches, homeId, awayId, h2hMatches = []) {
  const ratings = new Map();

  const allMatches = [...homeMatches, ...awayMatches, ...h2hMatches]
    .filter(m => m.fixture?.id)
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  const seen = new Set();
  for (const m of allMatches) {
    const fid = m.fixture.id;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const hId = m.teams?.home?.id;
    const aId = m.teams?.away?.id;
    if (!hId || !aId) continue;

    const hg = m.goals?.home ?? 0;
    const ag = m.goals?.away ?? 0;

    const hElo = getOrSet(ratings, hId);
    const aElo = getOrSet(ratings, aId);

    const expH = 1 / (1 + Math.pow(10, (aElo - hElo) / 400));
    const actH = hg > ag ? 1 : hg === ag ? 0.5 : 0;

    ratings.set(hId, hElo + K * (actH       - expH));
    ratings.set(aId, aElo + K * ((1 - actH) - (1 - expH)));
  }

  const homeElo = Math.round(getOrSet(ratings, homeId));
  const awayElo = Math.round(getOrSet(ratings, awayId));
  const eloDiff = homeElo - awayElo;
  const homeWinProb = 1 / (1 + Math.pow(10, -eloDiff / 400));

  // Recent form (last 5 from each team's matches)
  function recentForm(matches, teamId) {
    return [...matches]
      .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date))
      .slice(0, 5)
      .map(m => {
        const isHome = m.teams?.home?.id === teamId;
        const gs = isHome ? m.goals?.home : m.goals?.away;
        const gc = isHome ? m.goals?.away : m.goals?.home;
        return gs > gc ? 'W' : gs === gc ? 'D' : 'L';
      });
  }

  return {
    homeElo,
    awayElo,
    eloDiff,
    homeWinProb: Math.round(homeWinProb * 1000) / 1000,
    awayWinProb: Math.round((1 - homeWinProb) * 1000) / 1000,
    homeForm: recentForm(homeMatches, homeId),
    awayForm: recentForm(awayMatches, awayId),
  };
}
