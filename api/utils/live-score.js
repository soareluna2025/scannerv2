// Live match scoring helpers — folosite de api/cron/scan.js + api/cron/scanner.js
// Calculează NGP (Next Goal Probability), GG live și markete Over X.X din statistici live.
// API extern: poissonProb, mkt, getStat, calcFeatures, calcNextGoal, calcGG, calcMarkets

export function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 0; i < k; i++) p = p * lambda / (i + 1);
  return p;
}

export function mkt(need, lambda) {
  if (need <= 0) return 100;
  let pFail = 0;
  for (let k = 0; k < need; k++) pFail += poissonProb(lambda, k);
  return Math.round(Math.max(5, Math.min(98, (1 - pFail) * 100)));
}

export function getStat(stats, teamIdx, type) {
  const team = stats?.[teamIdx]?.statistics;
  if (!Array.isArray(team)) return 0;
  const entry = team.find(s => s.type === type);
  const v = entry?.value;
  if (v === null || v === undefined || v === 'N/A' || v === '') return 0;
  return parseFloat(v) || 0;
}

export function calcFeatures(m, fd = {}) {
  const st  = m.statistics || [];
  const mn  = m.fixture?.status?.elapsed || 0;
  const hg  = m.goals?.home ?? 0;
  const ag  = m.goals?.away ?? 0;

  const hxg  = getStat(st, 0, 'expected_goals');
  const axg  = getStat(st, 1, 'expected_goals');
  const hSOT = getStat(st, 0, 'Shots on Goal');
  const aSOT = getStat(st, 1, 'Shots on Goal');
  const hSh  = getStat(st, 0, 'Shots off Goal') + hSOT;
  const aSh  = getStat(st, 1, 'Shots off Goal') + aSOT;
  const hp   = getStat(st, 0, 'Ball Possession') || 50;
  const hC   = getStat(st, 0, 'Corner Kicks');
  const aC   = getStat(st, 1, 'Corner Kicks');
  const hDA  = getStat(st, 0, 'Dangerous Attacks');
  const aDA  = getStat(st, 1, 'Dangerous Attacks');
  const hSv  = getStat(st, 0, 'Goalkeeper Saves');
  const aSv  = getStat(st, 1, 'Goalkeeper Saves');

  const txg  = hxg + axg;
  const tSh  = hSh + aSh;
  const tSOT = hSOT + aSOT;
  const tC   = hC + aC;
  const tDA  = hDA + aDA;

  return {
    hxg, axg, hSOT, aSOT, hSh, aSh, hp, hC, aC, hDA, aDA, hSv, aSv,
    txg, tSh, tSOT, tC, tDA, mn, hg, ag,
    xgTotal: Math.min(txg / 3, 1),
    hxgN: Math.min(hxg / 1.5, 1),
    axgN: Math.min(axg / 1.5, 1),
    shots: Math.min(tSh / 25, 1),
    corners: Math.min(tC / 15, 1),
    dangerousAttacks: tDA > 0 ? Math.min(tDA / 120, 1) : 0,
    timeProgress: Math.min(mn / 90, 1),
    isGoless: (hg + ag === 0) ? 1 : 0,
    homeFormGoals: fd.homeFormGoals ?? 0.35,
    awayFormGoals: fd.awayFormGoals ?? 0.35,
    homeFormGG:    fd.homeFormGG    ?? 0.45,
    awayFormGG:    fd.awayFormGG    ?? 0.45,
    h2hGoalRate:   fd.h2hGoalRate   ?? 0.35,
    h2hGGRate:     fd.h2hGGRate     ?? 0.45,
    xgSpike: 0, prsAcc: 0,
  };
}

export function calcNextGoal(f) {
  const mn = f.mn || 0;
  const remFrac = Math.max(0, Math.min(1, (90 - mn) / 90));
  let remXg = (f.txg / Math.max(mn, 1)) * (90 - mn);
  if (f.txg === 0) {
    remXg = ((f.homeFormGoals + f.awayFormGoals) / 2 * 2.5) * remFrac;
  }
  if (mn >= 70) remXg *= 1.2;
  if (mn >= 80) remXg *= 1.15;
  const prob = 1 - Math.exp(-Math.max(remXg, 0.05));
  return Math.round(Math.max(3, Math.min(97, prob * 100)));
}

export function calcGG(f) {
  const mn = f.mn || 0;
  const remFrac = Math.max(0, Math.min(1, (90 - mn) / 90));
  const histGG = (f.homeFormGG + f.awayFormGG) / 2 * 0.7 + f.h2hGGRate * 0.3;
  const hxgRate = mn > 0 ? (f.hxg / (mn / 90)) : f.hxg;
  const axgRate = mn > 0 ? (f.axg / (mn / 90)) : f.axg;
  const pScore = (lam, scored) => {
    if (scored > 0) return 1;
    return 1 - Math.exp(-Math.max(lam * remFrac, 0.05));
  };
  const hLam = Math.max(hxgRate > 0 ? hxgRate : f.homeFormGoals * 1.5, 0.3);
  const aLam = Math.max(axgRate > 0 ? axgRate : f.awayFormGoals * 1.5, 0.3);
  let ggPred = pScore(hLam, f.hg) * pScore(aLam, f.ag) * 0.6 + histGG * 0.4;
  if (f.hg === 0 && f.ag === 0 && mn >= 70) ggPred *= 0.75;
  if (f.hg === 0 && f.ag === 0 && mn >= 80) ggPred *= 0.65;
  return Math.round(Math.max(5, Math.min(95, ggPred * 100)));
}

export function calcMarkets(f) {
  const mn     = f.mn || 0;
  const totalG = f.hg + f.ag;
  const remFrac = Math.max(0, Math.min(1, (95 - mn) / 90));
  const lxg   = f.xgTotal > 0 ? f.txg * 3 : 0;
  const lform  = ((f.homeFormGoals + f.awayFormGoals) / 2) * 3;
  const lh2h   = f.h2hGoalRate * 3;
  let lb = lxg > 0 ? lxg * 0.55 + lform * 0.25 + lh2h * 0.2
                   : lform * 0.55 + lh2h * 0.45;
  if (lb < 0.8) lb = 1.6;
  const lr = lb * remFrac + f.xgSpike * 0.3 + f.prsAcc * 0.2;

  const lhf = f.homeFormGoals * 1.5;
  const laf = f.awayFormGoals * 1.5;
  const lhb = Math.max(f.hxgN > 0 ? f.hxgN * 1.5 * 0.6 + lhf * 0.4 : lhf, 0.3);
  const lab = Math.max(f.axgN > 0 ? f.axgN * 1.5 * 0.6 + laf * 0.4 : laf, 0.3);
  const lhr = lhb * remFrac + f.xgSpike * 0.1;
  const lar = lab * remFrac + f.prsAcc * 0.1;

  return {
    over05: mkt(Math.max(0, 1 - totalG), lr),
    over15: mkt(Math.max(0, 2 - totalG), lr),
    over25: mkt(Math.max(0, 3 - totalG), lr),
    gg:     calcGG(f),
    home05: mkt(Math.max(0, 1 - f.hg), lhr),
    home15: mkt(Math.max(0, 2 - f.hg), lhr),
    away05: mkt(Math.max(0, 1 - f.ag), lar),
    away15: mkt(Math.max(0, 2 - f.ag), lar),
  };
}
