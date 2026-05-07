export function calcMomentum(liveStats) {
  if (!liveStats || !liveStats.minute) return null;

  const {
    homeShotsOnTarget = 0, awayShotsOnTarget = 0,
    homeDangerousAttacks = 0, awayDangerousAttacks = 0,
    homePossession = 50, homexG = 0, awayxG = 0,
    homeCorners = 0, awayCorners = 0,
  } = liveStats;

  const homeScore = homeShotsOnTarget * 15 + homeDangerousAttacks * 3 +
                    homePossession * 0.5 + homeCorners * 5 + homexG * 20;
  const awayScore = awayShotsOnTarget * 15 + awayDangerousAttacks * 3 +
                    (100 - homePossession) * 0.5 + awayCorners * 5 + awayxG * 20;

  const total = homeScore + awayScore || 1;
  const rawDiff = homeScore - awayScore;
  const normalized = Math.round((rawDiff / total) * 100);
  const score = Math.max(-100, Math.min(100, normalized));

  const team = score > 15 ? 'home' : score < -15 ? 'away' : 'balanced';
  const abs  = Math.abs(score);
  const intensity = abs > 50 ? 'HIGH' : abs > 25 ? 'MED' : 'LOW';

  const descriptions = {
    home: { HIGH: 'Gazdele domină cu pressing intens', MED: 'Gazdele au controlul jocului', LOW: 'Ușoară superioritate a gazdelor' },
    away: { HIGH: 'Oaspeții au preluat controlul total', MED: 'Oaspeții dictează ritmul', LOW: 'Ușoară superioritate a oaspeților' },
    balanced: { HIGH: 'Meci echilibrat cu ritm ridicat', MED: 'Echilibru total în teren', LOW: 'Joc lent, fără dominanță clară' },
  };

  return {
    score,
    team,
    intensity,
    trend: 'stable',
    description: descriptions[team][intensity],
  };
}
