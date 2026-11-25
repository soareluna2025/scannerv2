// camera-core.js — logica PURA a Camerei (fara retea/DB), testabila. Aloha NU alege pariuri: evalueaza doar intrarile utilizatorului.
export const MARKETS = ['over05', 'over15', 'home', 'away'];
export const DEFAULT_SETTINGS = {
  mode: 'paper',        // 'paper' | 'alert' (live = inexistent in cod)
  running: false,       // START / STOP
  stake: 5, pmin: 60, pmax: 89,
  compound: false, bankroll: 100,   // compus: miza = bani liberi (bankroll + profit realizat - miza deschisa)
  dailyCap: 0, matchCap: 0,         // 0 = fara limita
  liq: 0, losses: 0,                // 0 = oprit
};

export function normSettings(s) {
  const o = { ...DEFAULT_SETTINGS, ...(s || {}) };
  const n = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  o.stake = n(o.stake, 0.5, 1e6, 5); o.bankroll = n(o.bankroll, 1, 1e7, 100);
  o.pmin = Math.round(n(o.pmin, 1, 99, 60)); o.pmax = Math.round(n(o.pmax, 1, 99, 89));
  if (o.pmin > o.pmax) o.pmin = o.pmax;
  o.dailyCap = n(o.dailyCap, 0, 1e7, 0); o.matchCap = n(o.matchCap, 0, 1e7, 0);
  o.liq = n(o.liq, 0, 1e7, 0); o.losses = Math.round(n(o.losses, 0, 100, 0));
  o.mode = o.mode === 'alert' ? 'alert' : 'paper';   // niciodata 'live'
  o.running = !!o.running; o.compound = !!o.compound;
  return o;
}

// Miza efectiva: manuala per intrare, sau (compus) toti banii liberi.
export function effectiveStake(entry, settings, ctx) {
  const s = normSettings(settings);
  if (s.compound) return Math.floor(Math.max(0, (ctx.freeBalance ?? 0)) * 100) / 100;
  return Number(entry.stake ?? s.stake);
}

// Faza intrarii: 'prematch' | 'live' | 'closed'. liveMin = minutul REAL din feed-ul live (live_stats, scris de scanner din fluxul API); fara el, aproximare din ora de start.
export function entryPhase(entry, now = new Date(), liveMin = null) {
  if (!entry.kickoff) return 'prematch';
  const approx = (now.getTime() - new Date(entry.kickoff).getTime()) / 60000;
  if (approx < 0 && liveMin == null) return 'prematch';
  const min = liveMin != null ? liveMin : approx;
  if (entry.live_to != null && min >= (entry.live_from ?? 0) && min <= entry.live_to) return 'live';
  return 'closed';
}

// book = { ask: 0.75, depthAtOrBelowMax: USDC }. ctx = { spentToday, spentOnMatch, consecutiveLosses, freeBalance }
export function evaluate(entry, book, settings, ctx) {
  const s = normSettings(settings);
  if (!s.running) return { fire: false, reason: 'not_running' };
  if (s.losses > 0 && ctx.consecutiveLosses >= s.losses) return { fire: false, reason: 'loss_streak' };
  if (!book || book.ask == null) return { fire: false, reason: 'no_price' };
  const stake = effectiveStake(entry, s, ctx);
  if (!(stake >= 0.5)) return { fire: false, reason: 'no_balance' };
  const lo = (entry.pmin ?? s.pmin) / 100, hi = (entry.pmax ?? s.pmax) / 100, ask = Number(book.ask);
  if (ask > hi) return { fire: false, reason: 'price_above', ask };   // asteapta sa scada
  if (ask < lo) return { fire: false, reason: 'price_below', ask };
  if (s.dailyCap > 0 && ctx.spentToday + stake > s.dailyCap) return { fire: false, reason: 'daily_cap' };
  if (s.matchCap > 0 && ctx.spentOnMatch + stake > s.matchCap) return { fire: false, reason: 'match_cap' };
  if ((book.depthAtOrBelowMax ?? 0) < Math.max(stake, s.liq)) return { fire: false, reason: 'liquidity' };
  return { fire: true, price: ask, stake };
}

// Decontare: pentru piata 'over05' castig daca total >= 1, 'over15' daca >= 2, home/away daca echipa a marcat.
export function settle(market, homeGoals, awayGoals, price, stake) {
  const t = homeGoals + awayGoals;
  const win = market === 'over05' ? t >= 1 : market === 'over15' ? t >= 2 : market === 'home' ? homeGoals >= 1 : awayGoals >= 1;
  return { result: win ? 'win' : 'loss', pnl: win ? +(stake * (1 / price - 1)).toFixed(2) : -stake };
}
export const settleOver05 = (g, p, s) => settle('over05', g, 0, p, s);
