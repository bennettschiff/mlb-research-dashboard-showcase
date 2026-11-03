// ── HealthHud: on-screen readout for the freeze detector ──────────────────────
//
// Self-gating overlay. Hidden by default; show it with `?health=1` in the URL
// or toggle with Ctrl+Shift+H (preference persisted in localStorage). When a
// main-thread stall is recorded (src/lib/health.js) the panel flashes red and
// lists the recent freezes with duration, the last control you clicked, and
// any fetches that were still pending — so you can read the cause instead of
// describing it. Survives a tab reload via the localStorage ring buffer.

import { useEffect, useState } from 'react';
import { getEvents, clearEvents, subscribe } from '../lib/health.js';

const TOGGLE_KEY = 'sp_health_hud';

function hudInitiallyVisible() {
  try {
    if (new URLSearchParams(location.search).get('health') === '1') return true;
    return localStorage.getItem(TOGGLE_KEY) === '1';
  } catch { return false; }
}

export default function HealthHud() {
  const [visible, setVisible] = useState(hudInitiallyVisible);
  const [events, setEvents] = useState(() => getEvents());
  const [flash, setFlash] = useState(false);

  // Re-render whenever a new stall is recorded; flash on arrival.
  useEffect(() => subscribe(() => {
    setEvents(getEvents());
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  }), []);

  // Ctrl+Shift+H toggles visibility and remembers the choice.
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
        setVisible((v) => {
          const next = !v;
          try { localStorage.setItem(TOGGLE_KEY, next ? '1' : '0'); } catch { /* noop */ }
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!visible) return null;

  const recent = [...events].reverse().slice(0, 8);
  const last = recent[0];

  return (
    <div style={{
      position: 'fixed', bottom: 12, right: 12, zIndex: 99999,
      width: 320, maxHeight: '60vh', overflowY: 'auto',
      background: flash ? 'rgba(120,20,20,0.96)' : 'rgba(230,230,235,0.94)',
      color: '#1c2430', font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      border: `1px solid ${flash ? '#cc2b2b' : '#c6c6ce'}`, borderRadius: 8,
      padding: '8px 10px', boxShadow: '0 4px 18px rgba(0,0,0,0.175)',
      transition: 'background 0.3s, border-color 0.3s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong style={{ color: '#c25555' }}>⚡ Freeze monitor</strong>
        <span>
          <button onClick={() => { clearEvents(); setEvents([]); }}
            style={btnStyle}>clear</button>
          <button onClick={() => { setVisible(false); try { localStorage.setItem(TOGGLE_KEY, '0'); } catch { /* noop */ } }}
            style={btnStyle}>×</button>
        </span>
      </div>

      <div style={{ color: '#5c626e', marginBottom: 6 }}>
        {events.length === 0
          ? 'No stalls recorded. Watching…'
          : `${events.length} stall${events.length === 1 ? '' : 's'} · last ${last ? new Date(last.at).toLocaleTimeString() : ''}`}
      </div>

      {recent.map((ev, i) => (
        <div key={i} style={{ borderTop: '1px solid #d6d6dc', padding: '5px 0' }}>
          <div>
            <span style={{ color: '#d03131', fontWeight: 700 }}>{(ev.stallMs / 1000).toFixed(1)}s froze</span>
            <span style={{ color: '#6f7077' }}> · {new Date(ev.at).toLocaleTimeString()}</span>
            {ev.longestTaskMs != null && (
              <span style={{ color: '#6f7077' }}> · task {ev.longestTaskMs}ms</span>
            )}
          </div>
          {ev.lastAction?.label && (
            <div style={{ color: '#454c58' }}>last click: <b>{ev.lastAction.label}</b></div>
          )}
          {ev.pending?.length > 0 && (
            <div style={{ color: '#a97614' }}>
              pending: {ev.pending.map((p) => `${shortUrl(p.url)} (${p.pendingMs}ms)`).join(', ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const btnStyle = {
  background: 'transparent', color: '#5c626e', border: '1px solid #c6c6ce',
  borderRadius: 4, cursor: 'pointer', font: 'inherit', marginLeft: 4, padding: '1px 6px',
};

function shortUrl(u) {
  try { const url = new URL(u, location.href); return url.pathname + (url.search ? '?…' : ''); }
  catch { return String(u).slice(0, 40); }
}
