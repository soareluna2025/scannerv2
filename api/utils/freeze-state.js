// api/utils/freeze-state.js — stare PARTAJATĂ pentru meciuri „înghețate" (minut blocat).
// Map-uri la nivel de modul (persistă între scan-uri și re-add-uri din `raw`; NU se
// șterg când API-Football retrimite meciul). Folosite de scanner.js (tracking +
// cleanup) și de orice cale de IEȘIRE a listei live (WS broadcast + REST football.js)
// pentru a FILTRA meciurile frozen-dead — NU le ștergem din cache, doar le ascundem.
//
// NU atinge scoring/NGP — pură igienă a listei live.

export const ACTIVE_PLAY = new Set(['1H', '2H', 'ET']);   // joc activ: minutul TREBUIE să crească
export const PAUSED      = new Set(['HT', 'BT', 'INT', 'SUSP', 'P']); // pauze legitime (minut static OK)
export const FREEZE_MS   = 600_000;                        // 10 min fără avans → frozen-dead

export const _lastElapsed = {};   // id -> ultimul elapsed văzut
export const _frozenSince = {};   // id -> timestamp de când minutul nu mai crește
const _frozenLogged       = new Set(); // id-uri deja logate (evită spam la fiecare scan)

// Actualizează tracking-ul minutului pt un meci live. Apelat la FIECARE apariție în `raw`.
export function trackElapsed(id, el, st) {
  const now = Date.now();
  el = el || 0;
  if (_lastElapsed[id] === undefined) {
    _lastElapsed[id] = el; _frozenSince[id] = now;
    return;
  }
  if (el > _lastElapsed[id]) {            // progres real → resetează ceasul de îngheț
    _lastElapsed[id] = el; _frozenSince[id] = now;
    _frozenLogged.delete(id);             // a reluat → permite un log viitor dacă reîngheață
    return;
  }
  if (PAUSED.has(st)) {                    // pauză legitimă → NU se numără ca îngheț
    _frozenSince[id] = now;
    return;
  }
  // el === _lastElapsed[id] și st ∈ ACTIVE_PLAY → NU atinge _frozenSince (lasă-l să îmbătrânească).
}

// True dacă meciul e „înghețat mort": joc activ + minut blocat > FREEZE_MS.
export function isFrozenDead(id, st) {
  return ACTIVE_PLAY.has(st) && _frozenSince[id] && (Date.now() - _frozenSince[id] > FREEZE_MS);
}

// Log o SINGURĂ dată când un meci devine frozen-dead (fără spam la fiecare scan).
export function maybeLogFrozen(id, home, el) {
  if (_frozenLogged.has(id)) return;
  _frozenLogged.add(id);
  console.log(`[FREEZE] hiding ${id} ${home || ''} stuck @${el || _lastElapsed[id] || '?'}'`);
}

// Curăță starea unui meci (DONE_STATUS sau prune-by-absence).
export function clearFreeze(id) {
  delete _lastElapsed[id];
  delete _frozenSince[id];
  _frozenLogged.delete(id);
}
