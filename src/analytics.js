// Analytics: every event gets the install id, the day number since install (D0, D1, ...)
// and the session number, is kept in a local log, and is sent to config.analytics.endpoint
// when one is set. No endpoint = local log only (read it with plinkoAnalytics.dump()).
export function createAnalytics(cfg, { enabled }) {
  const KEY = cfg.storageKey;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
  const now = Date.now();
  let st = enabled ? read() : null;
  if (!st) st = { id: Math.random().toString(36).slice(2) + now.toString(36), installedAt: now, sessions: 0, days: [], log: [] };
  const day = () => Math.floor((Date.now() - st.installedAt) / 86400000);
  let session = st.sessions, startedAt = now, queue = [], open = false;

  function track(name, props = {}) {
    if (!enabled) return;
    const e = { name, t: Date.now(), id: st.id, day: day(), session, ...props };
    st.log.push(e);
    if (st.log.length > cfg.maxLocalEvents) st.log.splice(0, st.log.length - cfg.maxLocalEvents);
    queue.push(e);
  }
  function flush() {
    if (!enabled) return;
    write(st);
    if (!cfg.endpoint || !queue.length) { queue = []; return; }
    const body = JSON.stringify({ events: queue });
    queue = [];
    try { if (!navigator.sendBeacon?.(cfg.endpoint, body)) fetch(cfg.endpoint, { method: 'POST', body, keepalive: true }).catch(() => {}); } catch { /* offline */ }
  }
  /** Call when play starts or the player comes back; awaySec says how long they were gone. */
  function startSession(awaySec = 0) {
    session = ++st.sessions; startedAt = Date.now(); open = true;
    const d = day();
    if (!st.days.includes(d)) st.days.push(d);
    track('session_start', { awaySec: Math.round(awaySec), daysPlayed: st.days.length });
    flush();
  }
  function endSession(extra = {}) { if (!open) return; open = false; track('session_end', { durSec: Math.round((Date.now() - startedAt) / 1000), ...extra }); flush(); }

  return {
    track, flush, startSession, endSession,
    /** Local summary: which days this install came back on (D1/D3/D7 at a glance) and the raw log. */
    dump: () => ({ id: st.id, installedAt: new Date(st.installedAt).toISOString(), sessions: st.sessions, daysPlayed: st.days, d1: st.days.includes(1), d3: st.days.includes(3), d7: st.days.includes(7), events: st.log }),
  };
}
