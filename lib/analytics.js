// Lightweight event log + summary aggregation. All in chrome.storage.local.
// Events are capped at MAX_EVENTS to keep storage bounded.

import { getState, setState } from "./storage.js";

const MAX_EVENTS = 5000;

export async function logEvent(type, fields = {}) {
  const { analytics } = await getState();
  const events = analytics?.events || [];
  events.push({ ts: Date.now(), type, ...fields });
  // trim oldest if over cap
  const trimmed = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
  await setState({ analytics: { events: trimmed } });
}

function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function todayKey() { return dayKey(Date.now()); }

function weekStartTs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // Monday-start week
  const dow = (d.getDay() + 6) % 7; // 0=Mon
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export async function computeSummary() {
  const { analytics, session } = await getState();
  const events = analytics?.events || [];
  const now = Date.now();
  const today = todayKey();
  const weekStart = weekStartTs();

  let focusToday = 0, focusWeek = 0, focusAll = 0;
  let sessionsToday = 0, sessionsWeek = 0, sessionsAll = 0;
  let blockApproved = 0, blockDenied = 0, blockAttempts = 0;
  let driftRevocations = 0;

  const blockedDomains = {};      // domain -> attempt count
  const dailySeries = {};         // last 14 days
  const sessionLengths = [];
  const daysWithSessions = new Set();

  // Pre-fill 14-day series
  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dailySeries[dayKey(d.getTime())] = 0;
  }

  for (const ev of events) {
    const ts = ev.ts || 0;
    const d = dayKey(ts);

    switch (ev.type) {
      case "session_end": {
        const dur = Math.max(0, ev.duration_ms || 0) / 1000;
        sessionLengths.push(dur);
        if (d === today) { focusToday += dur; sessionsToday += 1; }
        if (ts >= weekStart) { focusWeek += dur; sessionsWeek += 1; }
        focusAll += dur; sessionsAll += 1;
        daysWithSessions.add(d);
        if (d in dailySeries) dailySeries[d] += dur;
        break;
      }
      case "block_attempt": {
        blockAttempts += 1;
        const host = ev.host || "";
        if (host) blockedDomains[host] = (blockedDomains[host] || 0) + 1;
        break;
      }
      case "block_approved": blockApproved += 1; break;
      case "block_denied":   blockDenied += 1; break;
      case "drift_revoked":  driftRevocations += 1; break;
    }
  }

  // Add live session if running
  if (session?.startedAt) {
    const liveDur = (now - session.startedAt) / 1000;
    if (liveDur > 0) {
      const d = dayKey(session.startedAt);
      focusAll += liveDur;
      if (d === today) focusToday += liveDur;
      if (session.startedAt >= weekStart) focusWeek += liveDur;
      if (d in dailySeries) dailySeries[d] += liveDur;
      daysWithSessions.add(d);
    }
  }

  // Streak
  let streak = 0;
  const cur = new Date(); cur.setHours(0, 0, 0, 0);
  while (daysWithSessions.has(dayKey(cur.getTime()))) {
    streak += 1;
    cur.setDate(cur.getDate() - 1);
  }

  const topDomains = Object.entries(blockedDomains)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const avgSessionSec = sessionLengths.length
    ? Math.round(sessionLengths.reduce((s, x) => s + x, 0) / sessionLengths.length)
    : 0;

  return {
    focusToday: Math.round(focusToday),
    focusWeek: Math.round(focusWeek),
    focusAll: Math.round(focusAll),
    sessionsToday, sessionsWeek, sessionsAll,
    blockAttempts, blockApproved, blockDenied,
    driftRevocations,
    topBlockedDomains: topDomains,
    dailySeries, // {date: secs}
    streakDays: streak,
    avgSessionSec
  };
}

export async function clearAnalytics() {
  await setState({ analytics: { events: [] } });
}
