function poissonRandom(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

// currentHome/currentAway = goals already scored (live matches)
export function runSimulation(lambdaHome, lambdaAway, simCount = 10000, currentHome = 0, currentAway = 0) {
  const scoreCounts = {};
  let homeWins = 0, draws = 0, awayWins = 0;
  let over05 = 0, over15 = 0, over25 = 0, over35 = 0, gg = 0;
  const minuteBuckets = [0, 0, 0, 0, 0, 0];
  let totalGoals = 0;

  for (let i = 0; i < simCount; i++) {
    // Simulate remaining goals, then add current score
    const addH = poissonRandom(lambdaHome);
    const addA = poissonRandom(lambdaAway);
    const hg = currentHome + addH;
    const ag = currentAway + addA;
    const total = hg + ag;

    const key = `${hg}-${ag}`;
    scoreCounts[key] = (scoreCounts[key] || 0) + 1;

    if (hg > ag) homeWins++;
    else if (hg === ag) draws++;
    else awayWins++;

    if (total > 0) over05++;
    if (total > 1) over15++;
    if (total > 2) over25++;
    if (total > 3) over35++;
    if (hg > 0 && ag > 0) gg++;

    // Goal timing tracks only additional goals (remaining time)
    for (let g = 0; g < addH + addA; g++) {
      const min = Math.floor(Math.random() * 90) + 1;
      const bucket = Math.min(5, Math.floor((min - 1) / 15));
      minuteBuckets[bucket]++;
      totalGoals++;
    }
  }

  const scoreDistribution = Object.entries(scoreCounts)
    .map(([score, count]) => ({ score, prob: Math.round(count / simCount * 1000) / 10 }))
    .filter(x => x.prob >= 1)
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 10);

  const top3Coverage = scoreDistribution.slice(0, 3).reduce((s, x) => s + x.prob, 0);
  const confidence = top3Coverage > 40 ? 'HIGH' : top3Coverage > 25 ? 'MED' : 'LOW';

  const bucketLabels = ['1-15', '16-30', '31-45', '46-60', '61-75', '76-90'];
  const goalTiming = {};
  bucketLabels.forEach((label, i) => {
    goalTiming[label] = totalGoals > 0 ? Math.round(minuteBuckets[i] / totalGoals * 100) : 0;
  });

  return {
    simCount,
    results: {
      homeWin: Math.round(homeWins / simCount * 1000) / 10,
      draw:    Math.round(draws    / simCount * 1000) / 10,
      awayWin: Math.round(awayWins / simCount * 1000) / 10,
    },
    markets: {
      over05: Math.round(over05 / simCount * 1000) / 10,
      over15: Math.round(over15 / simCount * 1000) / 10,
      over25: Math.round(over25 / simCount * 1000) / 10,
      over35: Math.round(over35 / simCount * 1000) / 10,
      gg:     Math.round(gg     / simCount * 1000) / 10,
      bttsNo: Math.round((simCount - gg) / simCount * 1000) / 10,
    },
    scoreDistribution,
    mostLikelyScore:       scoreDistribution[0]?.score || `${currentHome}-${currentAway}`,
    secondMostLikelyScore: scoreDistribution[1]?.score || `${currentHome + 1}-${currentAway}`,
    goalTiming,
    confidence,
  };
}
