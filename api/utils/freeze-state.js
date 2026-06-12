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
export const STALE_DRIFT_MS = 75 * 60 * 1000;              // 75 min marjă drift ceas real (restart-proof)

export const _lastElapsed = {};   // id -> ultimul elapsed văzut
export const _frozenSince = {};   // id -> timestamp de când minutul nu mai crește
const _frozenLogged       = new Map(); // id -> reason deja logat (evită spam la fiecare scan)

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

// Motivul de îngheț: null | 'observed' | 'drift'. kickoffMs/elapsedMin OPȚIONALI.
//  (a) observed — fereastra de observație _frozenSince > FREEZE_MS (se pierde la restart).
//  (c) drift    — pe CEAS REAL (restart-proof): minutul a rămas în urmă cu > STALE_DRIFT_MS
//                 față de cât ar fi trebuit să treacă de la kickoff.
export function freezeReason(id, st, kickoffMs, elapsedMin) {
  if (!ACTIVE_PLAY.has(st)) return null;
  if (_frozenSince[id] && Date.now() - _frozenSince[id] > FREEZE_MS) return 'observed';
  if (Number.isFinite(kickoffMs) && Number.isFinite(elapsedMin)) {
    const since = Date.now() - kickoffMs;     // timp real de la start
    const expected = elapsedMin * 60000;       // cât ar trebui să fi trecut
    if (since - expected > STALE_DRIFT_MS) return 'drift';
  }
  return null;
}

// True dacă meciul e „înghețat mort". Parametrii kickoffMs/elapsedMin sunt OPȚIONALI
// (fără ei → doar observația, comportament ca înainte).
export function isFrozenDead(id, st, kickoffMs, elapsedMin) {
  return freezeReason(id, st, kickoffMs, elapsedMin) !== null;
}

// Log o SINGURĂ dată când un meci devine frozen-dead (fără spam la fiecare scan).
// Include motivul (observed/drift) ca să știm care verificare a tras.
export function maybeLogFrozen(id, home, el, reason) {
  if (_frozenLogged.has(id)) return;
  _frozenLogged.set(id, reason || 'observed');
  console.log(`[FREEZE] hiding ${id} ${home || ''} stuck @${el || _lastElapsed[id] || '?'}' (${reason || 'observed'})`);
}

// Curăță starea unui meci (DONE_STATUS sau prune-by-absence).
export function clearFreeze(id) {
  delete _lastElapsed[id];
  delete _frozenSince[id];
  _frozenLogged.delete(id);
}

// [P03] Persistență peste restart PM2: fereastra „observed" (_frozenSince) trăia DOAR în
// memorie → se pierdea la restart și meciurile rămâneau înghețate până la regula „drift"
// (75 min). snapshot/restore permit salvarea în app_settings + reîncărcarea la boot.
// Timestamp-urile sunt absolute (epoch ms), deci ceasul de îngheț continuă corect.
export function snapshotFreeze() {
  return { le: { ..._lastElapsed }, fs: { ..._frozenSince } };
}
export function restoreFreeze(s) {
  if (!s || typeof s !== 'object') return;
  if (s.le) Object.assign(_lastElapsed, s.le);
  if (s.fs) Object.assign(_frozenSince, s.fs);
}
