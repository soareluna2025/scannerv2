// Consensus Engine — compares our model outputs with API-Football's independent predictions
// Returns consensusScore (0-100), signal details, and a small confidence boost/penalty
export function calcConsensus(result, apiPred) {
  if (!apiPred) return null;

  const details = {};
  let totalScore = 0, count = 0;

  // S1: Winner direction — do both models pick the same winner (H/D/A)?
  const apiPct = apiPred.predictions?.percent;
  if (apiPct) {
    const aH = parseFloat(apiPct.home)  || 0;
    const aD = parseFloat(apiPct.draws) || 0;
    const aA = parseFloat(apiPct.away)  || 0;
    const ourH = result.homeWin  ?? 33;
    const ourD = result.draw     ?? 33;
    const ourA = result.awayWin  ?? 33;
    const ourMax = Math.max(ourH, ourD, ourA);
    const apiMax = Math.max(aH, aD, aA);
    const ourWinner = ourMax === ourH ? 'H' : ourMax === ourD ? 'D' : 'A';
    const apiWinner = apiMax === aH   ? 'H' : apiMax === aD  ? 'D' : 'A';
    const s1 = ourWinner === apiWinner ? 100 : 0;
    details.winner = { ours: ourWinner, api: apiWinner, score: s1 };
    totalScore += s1; count++;
  }

  // S2: Over/Under direction — does API's under_over signal match our prob?
  // Format: "+2.5" = over 2.5 expected, "-1.5" = under 1.5 expected
  const uo = apiPred.predictions?.under_over;
  if (uo && typeof uo === 'string' && uo.length > 1) {
    const dir  = uo[0] === '+' ? 'over' : 'under';
    const line = parseFloat(uo.slice(1));
    let ourProb = null;
    if (line <= 1.6)      ourProb = result.over15Prob ?? null;
    else if (line <= 2.6) ourProb = result.over25Prob ?? null;
    if (ourProb != null) {
      const ourDir = ourProb >= 50 ? 'over' : 'under';
      const s2 = ourDir === dir ? 100 : 0;
      details.overUnder = { signal: uo, ourDir, score: s2 };
      totalScore += s2; count++;
    }
  }

  // S3: Lambda alignment — API's last_5 goals average vs our lambdaTotal
  const apiHomeGoals = parseFloat(apiPred.teams?.home?.last_5?.goals?.for?.average);
  const apiAwayGoals = parseFloat(apiPred.teams?.away?.last_5?.goals?.for?.average);
  if (!isNaN(apiHomeGoals) && !isNaN(apiAwayGoals)) {
    const apiEst = apiHomeGoals + apiAwayGoals;
    const ourEst = result.lambdaTotal ?? 2.4;
    const diff   = Math.abs(apiEst - ourEst);
    const s3 = Math.max(0, Math.min(100, 100 - diff * 20));
    details.lambda = { ours: +ourEst.toFixed(2), api: +apiEst.toFixed(2), score: Math.round(s3) };
    totalScore += s3; count++;
  }

  if (count === 0) return null;

  const consensusScore = Math.round(totalScore / count);
  const boost = consensusScore >= 75 ? 5 : consensusScore <= 30 ? -5 : 0;

  return { consensusScore, details, boost, signalCount: count };
}
