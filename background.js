// Service worker — navigation gating, message routing, drift detection,
// calendar-driven session auto-start, analytics logging, denial locks.

import {
  getState, setState, ensureDefaults, hostnameMatches, activeTempAllow
} from "./lib/storage.js";
import { evaluateReason, evaluateSiteRelevance, evaluateTitle } from "./lib/ai.js";
import { logEvent } from "./lib/analytics.js";
import { fetchUpcomingEvents, matchMapping } from "./lib/calendar.js";

const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");
const DRIFT_ALARM = "locus-drift";
const GC_ALARM = "locus-gc";
const CAL_SYNC_ALARM = "locus-cal-sync";
const CAL_EVENT_PREFIX = "locus-cal-evt:";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await rescheduleAlarms();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await rescheduleAlarms();
});

async function rescheduleAlarms() {
  chrome.alarms.create(GC_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(DRIFT_ALARM, { periodInMinutes: 0.25 }); // ~15s — see drift handler
  chrome.alarms.create(CAL_SYNC_ALARM, { periodInMinutes: 30 });
  await rescheduleCalendarEventAlarms();
}

// ─── Alarm dispatcher ─────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === GC_ALARM) return await gcTempAllowAndDenials();
    if (alarm.name === DRIFT_ALARM) return await driftSweep();
    if (alarm.name === CAL_SYNC_ALARM) return await tryCalendarSync();
    if (alarm.name.startsWith(CAL_EVENT_PREFIX)) return await onCalendarEventFire(alarm.name);
  } catch (e) {
    // Service workers can't crash on uncaught errors — swallow.
    console.warn("alarm error", alarm.name, e);
  }
});

async function gcTempAllowAndDenials() {
  const { tempAllow, denialLocks } = await getState();
  const now = Date.now();
  const nextTA = {};
  let changed = false;
  for (const [d, rec] of Object.entries(tempAllow || {})) {
    const exp = (typeof rec === "number") ? rec : rec?.exp;
    if (exp && exp > now) nextTA[d] = rec; else changed = true;
  }
  // Drop denial locks older than 6h (safety) — normally cleared on tab close/nav
  const nextDL = {};
  for (const [tabId, rec] of Object.entries(denialLocks || {})) {
    if (rec && rec.since && now - rec.since < 6 * 3600_000) nextDL[tabId] = rec;
    else changed = true;
  }
  if (changed) await setState({ tempAllow: nextTA, denialLocks: nextDL });
}

// ─── Block decision ───────────────────────────────────────────────────────
async function shouldBlock(url) {
  if (!url || !/^https?:/i.test(url)) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!host) return null;

  const { session, activities, alwaysAllowed, tempAllow } = await getState();
  if (!session || !session.activity) return null;

  const activity = activities[session.activity];
  if (!activity) return null;

  if (hostnameMatches(host, alwaysAllowed)) return null;
  if (hostnameMatches(host, activity.allowDomains || [])) return null;

  if (activeTempAllow(tempAllow, host)) return null;

  return { host, session: session.activity };
}

async function maybeRedirect(tabId, url) {
  // If this tab is denial-locked for the same host, force them to the blocked page.
  const { denialLocks } = await getState();
  const lock = denialLocks?.[String(tabId)];
  if (lock && url) {
    let host = "";
    try { host = new URL(url).hostname; } catch {}
    if (host && (host === lock.host || host.endsWith("." + lock.host))) {
      const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(url)}&host=${encodeURIComponent(lock.host)}&session=${encodeURIComponent(lock.session || "")}&denied=1`;
      if (!url.startsWith(BLOCKED_PAGE)) {
        try { await chrome.tabs.update(tabId, { url: target }); } catch {}
      }
      return;
    }
  }

  const blocked = await shouldBlock(url);
  if (!blocked) return;
  await logEvent("block_attempt", { host: blocked.host, session: blocked.session, url });
  const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(url)}&host=${encodeURIComponent(blocked.host)}&session=${encodeURIComponent(blocked.session)}`;
  try { await chrome.tabs.update(tabId, { url: target }); } catch {}
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  maybeRedirect(details.tabId, details.url);
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  maybeRedirect(details.tabId, details.url);
});

// Clear denial locks when tab navigates to a different host or is closed.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { denialLocks } = await getState();
  const lock = denialLocks?.[String(details.tabId)];
  if (!lock) return;
  let host = "";
  try { host = new URL(details.url).hostname; } catch {}
  if (!host) return;
  // If user is now on a different domain (and not on the blocked page), drop the lock.
  if (details.url.startsWith(BLOCKED_PAGE)) return;
  const sameHost = host === lock.host || host.endsWith("." + lock.host);
  if (!sameHost) {
    const next = { ...denialLocks };
    delete next[String(details.tabId)];
    await setState({ denialLocks: next });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { denialLocks } = await getState();
  if (denialLocks?.[String(tabId)]) {
    const next = { ...denialLocks };
    delete next[String(tabId)];
    await setState({ denialLocks: next });
  }
});

// ─── Drift detection ──────────────────────────────────────────────────────
// We can't run a content script on every page (perf + permissions), so the
// background polls every active temp-allowed tab and reads its title via
// chrome.scripting.executeScript. This mirrors evaluate_title.

async function driftSweep() {
  const { session, tempAllow, driftCheckEnabled, driftCheckSeconds } = await getState();
  if (!driftCheckEnabled || !session) return;
  if (!tempAllow || Object.keys(tempAllow).length === 0) return;

  // Throttle: alarms fire every 15s; honor user override (default 15).
  const interval = Math.max(10, Number(driftCheckSeconds) || 15) * 1000;
  const now = Date.now();
  let last = 0;
  try {
    const g = await chrome.storage.session.get("driftLastSweep");
    last = g?.driftLastSweep || 0;
  } catch {}
  if (now - last < interval) return;
  try { await chrome.storage.session.set({ driftLastSweep: now }); } catch {}

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let host = "";
    try { host = new URL(tab.url).hostname; } catch { continue; }
    const ta = activeTempAllow(tempAllow, host);
    if (!ta) continue;

    let title = tab.title || "";
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.title
      });
      if (res && typeof res.result === "string") title = res.result;
    } catch { /* permission denied on chrome:// etc — fall back to tab.title */ }

    const r = await evaluateTitle({
      domain: host,
      session: session.activity,
      task: session.task || "",
      tabTitle: title
    });
    if (!r.onTopic) {
      // Revoke this domain's temp-allow and redirect.
      const cur = (await getState()).tempAllow || {};
      const next = { ...cur };
      delete next[ta.domain];
      await setState({ tempAllow: next });
      await logEvent("drift_revoked", { host, session: session.activity, reason: r.reason });
      const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(tab.url)}&host=${encodeURIComponent(host)}&session=${encodeURIComponent(session.activity)}&drift=${encodeURIComponent(r.reason || "off-task")}`;
      try { await chrome.tabs.update(tab.id, { url: target }); } catch {}
    }
  }
}

// ─── Calendar event alarms ────────────────────────────────────────────────
async function rescheduleCalendarEventAlarms() {
  // Clear old per-event alarms.
  const all = await chrome.alarms.getAll();
  for (const a of all) {
    if (a.name.startsWith(CAL_EVENT_PREFIX)) await chrome.alarms.clear(a.name);
  }
  const { calendar } = await getState();
  if (!calendar?.upcoming?.length || !calendar?.mappings?.length) return;
  const now = Date.now();
  for (const ev of calendar.upcoming) {
    const startTs = Date.parse(ev.start || "");
    if (!startTs || startTs <= now) continue;
    const m = matchMapping(ev.title, calendar.mappings);
    if (!m || !m.autoStart) continue;
    chrome.alarms.create(`${CAL_EVENT_PREFIX}${ev.id}`, { when: startTs });
  }
}

async function onCalendarEventFire(alarmName) {
  const evId = alarmName.slice(CAL_EVENT_PREFIX.length);
  const { calendar, activities, session } = await getState();
  const ev = (calendar?.upcoming || []).find((x) => x.id === evId);
  if (!ev) return;
  const m = matchMapping(ev.title, calendar?.mappings || []);
  if (!m || !activities[m.activity]) return;
  if (session?.activity === m.activity) return; // already running
  await setState({
    session: { activity: m.activity, startedAt: Date.now(), task: ev.title || "" }
  });
  await logEvent("session_start", { activity: m.activity, source: "calendar", title: ev.title });
  try {
    await chrome.notifications?.create?.(`locus-cal-${evId}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Locus session started",
      message: `Auto-started ${m.activity} for ${ev.title}`
    });
  } catch {}
}

async function tryCalendarSync() {
  const { calendar } = await getState();
  if (!calendar?.googleToken) return;
  try {
    await fetchUpcomingEvents(14);
    await rescheduleCalendarEventAlarms();
  } catch (e) {
    // Likely token expired and refresh failed — leave for user to re-auth.
  }
}

// ─── Message API ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "getState":
          sendResponse(await getState()); break;

        case "startSession": {
          const { activities } = await getState();
          if (!activities[msg.activity]) {
            sendResponse({ ok: false, error: "Unknown activity" }); break;
          }
          await setState({
            session: {
              activity: msg.activity,
              startedAt: Date.now(),
              task: (msg.task || "").trim()
            },
            tempAllow: {},
            denialLocks: {}
          });
          await logEvent("session_start", { activity: msg.activity, task: msg.task || "" });
          sendResponse({ ok: true });
          break;
        }

        case "updateTask": {
          const { session } = await getState();
          if (!session) { sendResponse({ ok: false }); break; }
          await setState({ session: { ...session, task: (msg.task || "").trim() } });
          sendResponse({ ok: true });
          break;
        }

        case "stopSession": {
          const { session } = await getState();
          if (session?.startedAt) {
            await logEvent("session_end", {
              activity: session.activity,
              duration_ms: Date.now() - session.startedAt
            });
          }
          await setState({ session: null, tempAllow: {}, denialLocks: {} });
          sendResponse({ ok: true });
          break;
        }

        case "evaluateRelevance": {
          const { session } = await getState();
          if (!session) { sendResponse({ approved: false, reason: "no session" }); break; }
          const r = await evaluateSiteRelevance({
            domain: msg.host,
            session: session.activity,
            task: session.task || "",
            title: msg.title || ""
          });
          if (r.approved) {
            await grantTempAllow(msg.host, r.reason);
            await logEvent("block_approved", { host: msg.host, mode: "auto", reason: r.reason });
          }
          sendResponse(r);
          break;
        }

        case "evaluateReason": {
          const { session } = await getState();
          if (!session) { sendResponse({ approved: false, reason: "no session" }); break; }
          const r = await evaluateReason({
            domain: msg.host,
            session: session.activity,
            task: session.task || "",
            reason: msg.reason
          });
          const tabId = sender?.tab?.id;
          if (r.approved) {
            await grantTempAllow(msg.host, r.reason);
            await logEvent("block_approved", { host: msg.host, mode: "reason", reason: r.reason });
            // Clear denial lock for this tab if any.
            if (tabId != null) await clearDenialLock(tabId);
          } else {
            await logEvent("block_denied", { host: msg.host, reason: r.reason });
            if (tabId != null) await setDenialLock(tabId, msg.host, session.activity, r.reason);
          }
          sendResponse(r);
          break;
        }

        case "tryOverride": {
          const { overrideCode } = await getState();
          const ok = (msg.code || "").trim() === (overrideCode || "").trim() && !!overrideCode;
          if (ok) {
            await grantTempAllow(msg.host, "override code");
            await logEvent("override_used", { host: msg.host });
            const tabId = sender?.tab?.id;
            if (tabId != null) await clearDenialLock(tabId);
          }
          sendResponse({ ok });
          break;
        }

        case "calendar:sync":
          try {
            const items = await fetchUpcomingEvents(14);
            await rescheduleCalendarEventAlarms();
            sendResponse({ ok: true, count: items.length });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          break;

        case "calendar:reschedule":
          await rescheduleCalendarEventAlarms();
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

async function grantTempAllow(host, reason = "") {
  const { tempAllow, tempAllowMins } = await getState();
  const next = { ...(tempAllow || {}) };
  next[host] = { exp: Date.now() + (Number(tempAllowMins) || 10) * 60_000, reason };
  await setState({ tempAllow: next });
}

async function setDenialLock(tabId, host, sessionName, reason) {
  const { denialLocks } = await getState();
  const next = { ...(denialLocks || {}) };
  next[String(tabId)] = { host, session: sessionName, reason, since: Date.now() };
  await setState({ denialLocks: next });
}

async function clearDenialLock(tabId) {
  const { denialLocks } = await getState();
  if (!denialLocks?.[String(tabId)]) return;
  const next = { ...denialLocks };
  delete next[String(tabId)];
  await setState({ denialLocks: next });
}
