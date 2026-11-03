// ── Client health instrument: main-thread freeze detector ─────────────────────
//
// Catches the "cursor turns from pointer to arrow, nothing is clickable, then
// Chrome shows 'Page Unresponsive'" symptom. That symptom is a *main-thread
// block*: JS is stuck in one long synchronous task, so the browser can't
// process clicks or repaint. A heartbeat watchdog detects it — when the thread
// unblocks, the scheduled tick fires late, and the lateness ≈ the freeze length.
//
// On each stall we capture context (last user action, in-flight fetchJson
// calls, the blocking Long Task) and:
//   • keep a ring buffer in localStorage (survives killing the hung tab),
//   • beacon the event to /api/health-log via sendBeacon (survives an
//     unresponsive/closing tab where a normal fetch would die),
//   • notify the on-screen HUD.
// No Supabase writes — durable history lives in Vercel function logs.

const STALL_MS = 2000;      // a tick this late = we just lived through a freeze
const HEARTBEAT_MS = 1000;
const RING_KEY = 'sp_health_events';
const RING_MAX = 30;
const LONGTASK_MAX = 50;

let _started = false;
let _lastAction = null;            // { label, at } — last clicked control
let _seq = 0;
const _pending = new Map();        // id → { url, started }
const _recentLongTasks = [];       // { ms, at }
const _subs = new Set();

const now = () => performance.now();

// ── in-flight fetch registry (called by fetchJson in utils.js) ────────────────
export function registerFetch(url) {
  const id = ++_seq;
  _pending.set(id, { url, started: now() });
  return id;
}
export function unregisterFetch(id) { _pending.delete(id); }

function pendingSnapshot() {
  const t = now();
  return [..._pending.values()]
    .map((p) => ({ url: p.url, pendingMs: Math.round(t - p.started) }))
    .sort((a, b) => b.pendingMs - a.pendingMs)
    .slice(0, 8);
}

// ── ring buffer + subscribers ─────────────────────────────────────────────────
export function getEvents() {
  try { return JSON.parse(localStorage.getItem(RING_KEY) || '[]'); }
  catch { return []; }
}
function writeRing(events) {
  try { localStorage.setItem(RING_KEY, JSON.stringify(events.slice(-RING_MAX))); }
  catch { /* quota / private mode — HUD + beacon still work */ }
}
export function clearEvents() { writeRing([]); notify(); }
export function subscribe(fn) { _subs.add(fn); return () => _subs.delete(fn); }
function notify() { _subs.forEach((fn) => { try { fn(); } catch { /* noop */ } }); }

function record(event) {
  const events = getEvents();
  events.push(event);
  writeRing(events);
  notify();
  try {
    const blob = new Blob([JSON.stringify(event)], { type: 'application/json' });
    navigator.sendBeacon?.('/api/health-log', blob);
  } catch { /* sendBeacon unsupported / blocked */ }
  console.warn('[health] main-thread stall', event);
}

// ── start the watchdog (idempotent; call once from main.jsx) ───────────────────
export function start() {
  if (_started || typeof window === 'undefined') return;
  _started = true;

  // Remember the last interactive element the user touched.
  window.addEventListener('pointerdown', (e) => {
    const el = e.target?.closest?.(
      'button, a, [role="tab"], [role="button"], input, select, label',
    ) || e.target;
    const label = el?.getAttribute?.('aria-label')
      || el?.textContent?.trim()?.slice(0, 40)
      || el?.tagName
      || 'unknown';
    _lastAction = { label, at: new Date().toISOString() };
  }, { capture: true, passive: true });

  // Native Long Task observer — any main-thread task >50ms, with its duration.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        _recentLongTasks.push({ ms: Math.round(entry.duration), at: now() });
        if (_recentLongTasks.length > LONGTASK_MAX) _recentLongTasks.shift();
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* longtask unsupported (e.g. Safari) — watchdog still works */ }

  // Heartbeat watchdog: a tick that fires ≥STALL_MS late means we were frozen.
  let expected = now() + HEARTBEAT_MS;
  const tick = () => {
    const t = now();
    const drift = t - expected;          // how late this tick fired
    if (drift >= STALL_MS) {
      const stallMs = Math.round(drift);  // ≈ how long the thread was blocked
      const since = t - stallMs - 500;
      const blocking = _recentLongTasks
        .filter((lt) => lt.at >= since)
        .sort((a, b) => b.ms - a.ms)[0];
      record({
        type: 'stall',
        at: new Date().toISOString(),
        stallMs,
        longestTaskMs: blocking?.ms ?? null,
        lastAction: _lastAction,
        pending: pendingSnapshot(),
        url: location.href,
        ua: navigator.userAgent,
      });
    }
    expected = now() + HEARTBEAT_MS;
    setTimeout(tick, HEARTBEAT_MS);
  };
  setTimeout(tick, HEARTBEAT_MS);
}
