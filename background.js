// Service worker — navigation gating, message routing, drift detection,
// calendar sync, analytics logging, denial locks.

import {
  getState, setState, ensureDefaults, hostnameMatches, activeTempAllow
} from "./lib/storage.js";
import { evaluateReason, evaluateSiteRelevance, evaluateTitle } from "./lib/ai.js";
import { logEvent } from "./lib/analytics.js";
import { fetchUpcomingEvents } from "./lib/calendar.js";

const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");
const DRIFT_ALARM = "locus-drift";
const GC_ALARM = "locus-gc";
const CAL_SYNC_ALARM = "locus-cal-sync";
const SESSION_WATCH_ALARM = "locus-session-watch";

const LONG_SESSION_HOURS = 5;
const LONG_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const LONG_SESSION_SNOOZE_MS = 60 * 60 * 1000;

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
  chrome.alarms.create(DRIFT_ALARM, { periodInMinutes: 0.25 });
  chrome.alarms.create(CAL_SYNC_ALARM, { periodInMinutes: 30 });
  chrome.alarms.create(SESSION_WATCH_ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === GC_ALARM) return await gcTempAllowAndDenials();
    if (alarm.name === DRIFT_ALARM) return await driftSweep();
    if (alarm.name === CAL_SYNC_ALARM) return await tryCalendarSync();
    if (alarm.name === SESSION_WATCH_ALARM) return await checkLongSession();
  } catch (e) {
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
  const nextDL = {};
  for (const [tabId, rec] of Object.entries(denialLocks || {})) {
    if (rec && rec.since && now - rec.since < 6 * 3600_000) nextDL[tabId] = rec;
    else changed = true;
  }
  if (changed) await setState({ tempAllow: nextTA, denialLocks: nextDL });
}

// ─── Block decision ───────────────────────────────────────────────────────
// New rule: while a session is active, block everything except always-allowed.
async function shouldBlock(url) {
  if (!url || !/^https?:/i.test(url)) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!host) return null;

  const { session, alwaysAllowed, tempAllow } = await getState();
  if (!session) return null;

  if (hostnameMatches(host, alwaysAllowed)) return null;
  if (activeTempAllow(tempAllow, host)) return null;

  return { host, task: session.taskText || "" };
}

// Tracks in-progress AI evaluations so onBeforeNavigate + onCommitted
// for the same navigation don't fire two parallel AI calls.
const pendingEvals = new Map();

async function maybeRedirect(tabId, url) {
  const { denialLocks } = await getState();
  const lock = denialLocks?.[String(tabId)];
  if (lock && url) {
    let host = "";
    try { host = new URL(url).hostname; } catch {}
    if (host && (host === lock.host || host.endsWith("." + lock.host))) {
      const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(url)}&host=${encodeURIComponent(lock.host)}&task=${encodeURIComponent(lock.task || "")}&denied=1`;
      if (!url.startsWith(BLOCKED_PAGE)) {
        try { await chrome.tabs.update(tabId, { url: target }); } catch {}
      }
      return;
    }
  }

  const blocked = await shouldBlock(url);
  if (!blocked) return;

  const key = `${tabId}:${url}`;
  if (pendingEvals.has(key)) return;
  pendingEvals.set(key, true);

  try {
    const r = await evaluateSiteRelevance({ domain: blocked.host, task: blocked.task, url });
    if (r.approved) {
      await grantTempAllow(blocked.host, r.reason);
      await logEvent("block_approved", { host: blocked.host, mode: "auto", reason: r.reason });
    } else {
      await logEvent("block_attempt", { host: blocked.host, task: blocked.task, url });
      const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(url)}&host=${encodeURIComponent(blocked.host)}&task=${encodeURIComponent(blocked.task)}`;
      try { await chrome.tabs.update(tabId, { url: target }); } catch {}
    }
  } finally {
    pendingEvals.delete(key);
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  maybeRedirect(details.tabId, details.url);
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  maybeRedirect(details.tabId, details.url);
});

// Check a tab when the user switches to it (covers already-loaded pages).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) maybeRedirect(tabId, tab.url);
  } catch {}
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { denialLocks } = await getState();
  const lock = denialLocks?.[String(details.tabId)];
  if (!lock) return;
  let host = "";
  try { host = new URL(details.url).hostname; } catch {}
  if (!host) return;
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
async function driftSweep() {
  const { session, tempAllow, driftCheckEnabled, driftCheckSeconds } = await getState();
  if (!driftCheckEnabled || !session) return;
  if (!tempAllow || Object.keys(tempAllow).length === 0) return;

  const interval = Math.max(10, Number(driftCheckSeconds) || 15) * 1000;
  const now = Date.now();
  let last = 0;
  try {
    const g = await chrome.storage.session.get("driftLastSweep");
    last = g?.driftLastSweep || 0;
  } catch {}
  if (now - last < interval) return;
  try { await chrome.storage.session.set({ driftLastSweep: now }); } catch {}

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
    } catch {}

    const r = await evaluateTitle({
      domain: host,
      task: session.taskText || "",
      tabTitle: title,
      approvalReason: ta.reason || ""
    });
    if (!r.onTopic) {
      const cur = (await getState()).tempAllow || {};
      const next = { ...cur };
      delete next[ta.domain];
      await setState({ tempAllow: next });
      await logEvent("drift_revoked", { host, task: session.taskText || "", reason: r.reason });
      const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(tab.url)}&host=${encodeURIComponent(host)}&task=${encodeURIComponent(session.taskText || "")}&drift=${encodeURIComponent(r.reason || "off-task")}`;
      try { await chrome.tabs.update(tab.id, { url: target }); } catch {}
    }
  }
}

async function checkLongSession() {
  const { session } = await getState();
  if (!session?.startedAt) return;

  const elapsed = Date.now() - session.startedAt;
  if (elapsed < LONG_SESSION_HOURS * 3600_000) {
    try { await chrome.storage.session.remove(["longSessionWarnedAt", "longSessionKeptGoingAt"]); } catch {}
    return;
  }

  const sg = await chrome.storage.session.get(["longSessionWarnedAt", "longSessionKeptGoingAt"]).catch(() => ({}));
  const warnedAt = sg.longSessionWarnedAt || 0;
  const keptGoingAt = sg.longSessionKeptGoingAt || 0;

  if (keptGoingAt && Date.now() - keptGoingAt < LONG_SESSION_SNOOZE_MS) return;

  if (!warnedAt) {
    await chrome.storage.session.set({ longSessionWarnedAt: Date.now() });
    chrome.notifications.create("locus-long-session", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Still focusing?",
      message: `Your session has been running for over ${LONG_SESSION_HOURS} hours. Keep going or end it?`,
      buttons: [{ title: "Keep Going" }, { title: "End Session" }],
      requireInteraction: true,
    });
    return;
  }

  if (Date.now() - warnedAt > LONG_SESSION_TIMEOUT_MS) {
    try { chrome.notifications.clear("locus-long-session"); } catch {}
    await chrome.storage.session.remove(["longSessionWarnedAt", "longSessionKeptGoingAt"]);
    if (session?.startedAt) {
      await logEvent("session_end", { task: session.taskText || "", duration_ms: Date.now() - session.startedAt, reason: "long_session_timeout" });
    }
    await setState({ session: null, tempAllow: {}, denialLocks: {} });
  }
}

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (notifId !== "locus-long-session") return;
  chrome.notifications.clear(notifId);
  if (btnIdx === 0) {
    await chrome.storage.session.set({ longSessionKeptGoingAt: Date.now() });
    await chrome.storage.session.remove("longSessionWarnedAt");
  } else {
    const { session } = await getState();
    if (session?.startedAt) {
      await logEvent("session_end", { task: session.taskText || "", duration_ms: Date.now() - session.startedAt, reason: "long_session_user_ended" });
    }
    await setState({ session: null, tempAllow: {}, denialLocks: {} });
  }
});

async function tryCalendarSync() {
  const { calendar } = await getState();
  if (!calendar?.feeds?.length) return;
  try {
    await fetchUpcomingEvents(14);
  } catch {}
}

// ─── Message API ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "getState":
          sendResponse(await getState()); break;

        case "startSession": {
          const taskText = (msg.taskText || "").trim();
          if (!taskText) { sendResponse({ ok: false, error: "Task required" }); break; }
          await setState({
            session: {
              taskText,
              startedAt: Date.now(),
              source: msg.source === "calendar" ? "calendar" : "manual"
            },
            tempAllow: {},
            denialLocks: {}
          });
          await logEvent("session_start", { task: taskText, source: msg.source || "manual" });
          sendResponse({ ok: true });
          break;
        }

        case "updateTask": {
          const { session } = await getState();
          if (!session) { sendResponse({ ok: false }); break; }
          const taskText = (msg.taskText || "").trim();
          if (!taskText) { sendResponse({ ok: false, error: "empty" }); break; }
          await setState({ session: { ...session, taskText } });
          sendResponse({ ok: true });
          break;
        }

        case "stopSession": {
          const { session } = await getState();
          if (session?.startedAt) {
            await logEvent("session_end", {
              task: session.taskText || "",
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
            task: session.taskText || "",
            url: msg.url || ""
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
            task: session.taskText || "",
            reason: msg.reason
          });
          const tabId = sender?.tab?.id;
          if (r.approved) {
            await grantTempAllow(msg.host, r.reason);
            await logEvent("block_approved", { host: msg.host, mode: "reason", reason: r.reason });
            if (tabId != null) await clearDenialLock(tabId);
          } else {
            await logEvent("block_denied", { host: msg.host, reason: r.reason });
            if (tabId != null) await setDenialLock(tabId, msg.host, session.taskText || "", r.reason);
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
            sendResponse({ ok: true, count: items.length });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
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

async function setDenialLock(tabId, host, task, reason) {
  const { denialLocks } = await getState();
  const next = { ...(denialLocks || {}) };
  next[String(tabId)] = { host, task, reason, since: Date.now() };
  await setState({ denialLocks: next });
}

async function clearDenialLock(tabId) {
  const { denialLocks } = await getState();
  if (!denialLocks?.[String(tabId)]) return;
  const next = { ...denialLocks };
  delete next[String(tabId)];
  await setState({ denialLocks: next });
}
