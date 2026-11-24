// camera-core.js — logica PURA a Camerei (fara retea/DB), testabila. Aloha NU alege pariuri: doar evalueaza intrarile utilizatorului.
export const DEFAULT_SETTINGS = {
  mode: 'paper',          // 'paper' | 'alert' (live = oprit, nu exista in cod)
  stopped: false,
  stake: 5, pmin: 88, pmax: 89,
  dailyCap: 50, matchCap: 10,
  slip: 1, liq: 100,
  rate: 88, minute: 30, losses: 3,
};

export function normSettings(s) {
  const o = { ...DEFAULT_SETTINGS, ...(s || {}) };
  const n = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  o.stake = n(o.stake, 1, 1000, 5); o.pmin = Math.round(n(o.pmin, 50, 99, 88)); o.pmax = Math.round(n(o.pmax, 50, 99, 89));
  if (o.pmin > o.pmax) o.pmin = o.pmax;
  o.dailyCap = n(o.dailyCap, 1, 100000, 50); o.matchCap = n(o.matchCap, 1, 100000, 10);
  o.slip = n(o.slip, 0, 20, 1); o.liq = n(o.liq, 0, 1e6, 100);
  o.rate = n(o.rate, 0, 100, 88); o.minute = n(o.minute, 0, 120, 30); o.losses = Math.round(n(o.losses, 1, 50, 3));
  o.mode = o.mode === 'alert' ? 'alert' : 'paper';   // niciodata 'live'
  o.stopped = !!o.stopped;
  return o;
}

// Decide daca o intrare declanseaza acum. book = { ask: 0.88 (cel mai bun pret de cumparare), depthAtOrBelowMax: USDC disponibili <= pmax }
// ctx = { spentToday, spentOnMatch, consecutiveLosses, now:Date }
export function evaluate(entry, book, settings, ctx) {
  const s = normSettings(settings);
  if (s.stopped) return { fire: false, reason: 'stopped' };
  if (ctx.consecutiveLosses >= s.losses) return { fire: false, reason: 'loss_streak' };
  if (!book || book.ask == null) return { fire: false, reason: 'no_price' };
  const stake = Number(entry.stake ?? s.stake);
  const lo = (entry.pmin ?? s.pmin) / 100, hi = (entry.pmax ?? s.pmax) / 100;
  const ask = Number(book.ask);
  if (ask < lo || ask > hi + s.slip / 100) return { fire: false, reason: 'price_out_of_range', ask };
  if (ask > hi) return { fire: false, reason: 'slippage', ask };   // in afara intervalului dar in toleranta: nu intra (interval strict)
  if (ctx.spentToday + stake > s.dailyCap) return { fire: false, reason: 'daily_cap' };
  if (ctx.spentOnMatch + stake > s.matchCap) return { fire: false, reason: 'match_cap' };
  if ((book.depthAtOrBelowMax ?? 0) < Math.max(stake, s.liq)) return { fire: false, reason: 'liquidity' };
  return { fire: true, price: ask, stake };
}

// Rezultat Over 0.5: castig daca total goluri >= 1. PnL pentru cumparare la pretul p (0-1): castig = stake*(1/p - 1), pierdere = -stake.
export function settleOver05(totalGoals, price, stake) {
  const win = totalGoals >= 1;
  return { result: win ? 'win' : 'loss', pnl: win ? +(stake * (1 / price - 1)).toFixed(2) : -stake };
}
