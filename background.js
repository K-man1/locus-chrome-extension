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
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === GC_ALARM) return await gcTempAllowAndDenials();
    if (alarm.name === DRIFT_ALARM) return await driftSweep();
    if (alarm.name === CAL_SYNC_ALARM) return await tryCalendarSync();
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
  await logEvent("block_attempt", { host: blocked.host, task: blocked.task, url });
  const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(url)}&host=${encodeURIComponent(blocked.host)}&task=${encodeURIComponent(blocked.task)}`;
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
    } catch {}

    const r = await evaluateTitle({
      domain: host,
      task: session.taskText || "",
      tabTitle: title
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
