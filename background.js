// Service worker — navigation gating, message routing, drift detection,
// calendar sync, analytics logging, denial locks.

import {
  getState, setState, ensureDefaults, hostnameMatches, activeTempAllow, isAuthUrl
} from "./lib/storage.js";
import { evaluateReason, evaluateSiteRelevance, evaluateTitle } from "./lib/ai.js";
import { logEvent } from "./lib/analytics.js";
import { fetchUpcomingEvents } from "./lib/calendar.js";
import { getPomoPhase, sessionElapsed, POMO_WORK_OPTIONS, pomoMinutes, POMO_BREAK_MIN_DEFAULT } from "./lib/pomodoro.js";
import { dueSchedules, dateKey } from "./lib/schedule.js";
import { inLockWindow, windowBounds, allowedTask, resolveSettings } from "./lib/lockdown.js";

const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");
const DRIFT_ALARM = "locus-drift";
const GC_ALARM = "locus-gc";
const CAL_SYNC_ALARM = "locus-cal-sync";
const SESSION_WATCH_ALARM = "locus-session-watch";
const SCHEDULE_ALARM = "locus-schedule";
const POMO_PHASE_ALARM = "locus-pomo-phase";

const LONG_SESSION_HOURS = 5;
const LONG_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const LONG_SESSION_SNOOZE_MS = 60 * 60 * 1000;

// Drift tolerance. A site the user explicitly justified (typed reason / override
// code) is trusted for DRIFT_GRACE_MS before drift may revoke it — they made a
// deliberate call seconds ago, so don't second-guess it on the next 15s tick.
// After grace, and for auto-allowed sites, a single OFF_TOPIC read is not enough
// to revoke: gpt-4o-mini judging a vague, fast-changing title (e.g. an AI chat
// tab) is high-variance, so we require DRIFT_STRIKES_TO_REVOKE consecutive
// off-task reads before pulling access.
const DRIFT_GRACE_MS = 3 * 60 * 1000;
const DRIFT_STRIKES_TO_REVOKE = 2;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await ensureAlarms();
  await enforceLockdown();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await ensureAlarms();
  // Catch a schedule whose time passed while the browser was closed — the next
  // alarm tick could be up to a minute out, and we want same-slot startup.
  await checkSchedules();
  // Same idea for the lockdown: if the browser opens mid-window, lock in now
  // rather than waiting for the first 15s drift tick.
  await enforceLockdown();
});

// Create any missing periodic alarms. Runs on every service-worker start, not
// just install/startup: disabling an extension clears its alarms, and
// re-enabling fires neither onInstalled nor onStartup — without this the
// schedule/pomodoro alarms silently never come back. Only missing alarms are
// created, because re-creating an existing periodic alarm resets its
// countdown, and a worker that restarts more often than the period would push
// the alarm into the future forever.
async function ensureAlarms() {
  const existing = new Set((await chrome.alarms.getAll()).map((a) => a.name));
  const wanted = [
    [GC_ALARM, { periodInMinutes: 1 }],
    [DRIFT_ALARM, { periodInMinutes: 0.25 }],
    [CAL_SYNC_ALARM, { periodInMinutes: 30 }],
    [SESSION_WATCH_ALARM, { periodInMinutes: 1 }],
    [SCHEDULE_ALARM, { periodInMinutes: 1 }],
  ];
  for (const [name, info] of wanted) {
    if (!existing.has(name)) chrome.alarms.create(name, info);
  }
}
ensureAlarms();
// A worker can restart mid-window (MV3 sleeps them aggressively); re-assert the
// lock immediately instead of waiting up to 15s for the next drift tick.
enforceLockdown();

// Saving the lockdown config re-checks it right away. Without this, confirming
// "start it now" in the dashboard sits there doing nothing for up to 15s, which
// reads as a broken switch. enforceLockdown() never writes `lockdown` itself,
// so this can't feed back into itself.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "lockdown" in changes) enforceLockdown();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === GC_ALARM) return await gcTempAllowAndDenials();
    if (alarm.name === DRIFT_ALARM) {
      await enforceLockdown();
      await checkPomoTransition();
      return await driftSweep();
    }
    if (alarm.name === CAL_SYNC_ALARM) return await tryCalendarSync();
    if (alarm.name === SESSION_WATCH_ALARM) return await checkLongSession();
    if (alarm.name === SCHEDULE_ALARM) return await checkSchedules();
    if (alarm.name === POMO_PHASE_ALARM) return await checkPomoTransition();
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
// While a session is active, block everything except always-allowed.
// While paused, or during a Pomodoro break, allow everything.
function shouldBlock(url, state) {
  if (!url || !/^https?:/i.test(url)) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!host) return null;

  const { session, tempAllow } = state;
  // Strictness comes from the lockdown's own overrides while a lock is live.
  const { alwaysAllowed, pomodoroEnabled, pomodoroWorkMin, pomodoroBreakMin } = resolveSettings(state);
  if (!session || session.pausedAt) return null;

  if (pomodoroEnabled && session.startedAt) {
    const { phase } = getPomoPhase(sessionElapsed(session), pomodoroWorkMin, pomodoroBreakMin);
    if (phase === "break") return null;
  }

  if (isAuthUrl(url)) return null; // never block sign-in / OAuth / SSO flows
  if (hostnameMatches(host, alwaysAllowed)) return null;
  if (activeTempAllow(tempAllow, host)) return null;

  return { host, task: session.taskText || "" };
}

// Arm a one-shot alarm for the exact moment the current pomodoro phase ends.
// The 15s drift poll alone means the chime lands up to 15s (avg ~7.5s) after
// the real boundary; a `when`-based alarm fires right at it. The poll stays as
// a backstop for a lost alarm or a laptop asleep at the boundary. The +250ms
// pad keeps a slightly-early firing from landing on the old side of the
// boundary and re-arming without chiming.
async function armPomoPhaseAlarm() {
  const state = await getState();
  const { session } = state;
  const { pomodoroEnabled, pomodoroWorkMin, pomodoroBreakMin } = resolveSettings(state);
  if (!pomodoroEnabled || !session?.startedAt || session.pausedAt) {
    await chrome.alarms.clear(POMO_PHASE_ALARM).catch(() => {});
    return;
  }
  const { remaining } = getPomoPhase(sessionElapsed(session), pomodoroWorkMin, pomodoroBreakMin);
  chrome.alarms.create(POMO_PHASE_ALARM, { when: Date.now() + remaining + 250 });
}

// Session/setting changes all flow through chrome.storage.local, so this one
// listener re-arms the phase alarm on start/stop/pause/resume and on the
// pomodoro toggle, no matter which page made the change.
chrome.storage.onChanged.addListener((changes, area) => {
  // `lockdown` and `lockCommit` matter too: arming a lock can swap the pomodoro
  // lengths (or switch the timer off) without `pomodoroEnabled` ever changing.
  if (area !== "local") return;
  if ("session" in changes || "pomodoroEnabled" in changes ||
      "lockdown" in changes || "lockCommit" in changes) {
    armPomoPhaseAlarm();
  }
});

async function checkPomoTransition() {
  const state = await getState();
  const { session } = state;
  const { pomodoroEnabled, pomodoroWorkMin, pomodoroBreakMin } = resolveSettings(state);
  if (!pomodoroEnabled) return;
  if (!session?.startedAt || session.pausedAt) return;

  const { phase, round } = getPomoPhase(sessionElapsed(session), pomodoroWorkMin, pomodoroBreakMin);
  const phaseKey = `${phase}-${round}`;

  const sg = await chrome.storage.session.get("pomoLastPhase").catch(() => ({}));
  const lastPhaseKey = sg?.pomoLastPhase;

  if (lastPhaseKey && lastPhaseKey !== phaseKey) {
    const breakMin = pomoMinutes(pomodoroBreakMin, POMO_BREAK_MIN_DEFAULT);
    const msg = phase === "break"
      ? `Round ${round} done — take a ${breakMin}-minute break!`
      : `Break over — start round ${round}!`;

    chrome.notifications.create(`pomo-${phaseKey}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Locus · Pomodoro",
      message: msg,
    });

    if (phase === "work") {
      // Clear break-time browsing when focus resumes
      await setState({ tempAllow: {}, denialLocks: {} });
    }

    await playPomoSound(phase);
  }

  await chrome.storage.session.set({ pomoLastPhase: phaseKey });
  // Phase transitions don't touch chrome.storage.local, so the onChanged
  // listener won't re-arm for the next boundary — do it here.
  await armPomoPhaseAlarm();
}

async function playPomoSound(phase) {
  try {
    const existing = await chrome.offscreen.hasDocument().catch(() => false);
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen.html"),
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Pomodoro phase transition chime",
      });
    }
  } catch {}

  // A freshly created offscreen document may not have registered its message
  // listener yet, so the first send can be lost. Retry until it lands.
  for (let i = 0; i < 6; i++) {
    try {
      await chrome.runtime.sendMessage({ type: "playSound", sound: phase });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  setTimeout(async () => {
    try { await chrome.offscreen.closeDocument(); } catch {}
  }, 4000);
}

// De-dupes concurrent AI evaluations for the same tab+url so onCommitted and
// onActivated can't fire two parallel AI calls for the same navigation.
const pendingEvals = new Map();

// Best-effort page <title> for a tab, used to give the AI real page context.
// Only trust it once the tab has finished loading and its title isn't just the
// URL — mid-navigation (onCommitted) Chrome still reports the previous page's
// title, and passing that would poison the evaluation. Empty string = unknown.
async function reliableTitle(tabId, url) {
  try {
    const t = await chrome.tabs.get(tabId);
    const title = (t?.title || "").trim();
    if (!title || title === url) return "";
    if (t.status && t.status !== "complete") return "";
    return title;
  } catch { return ""; }
}

async function maybeRedirect(tabId, url) {
  const state = await getState();
  const { session, denialLocks } = state;

  // Paused → blocking is off entirely; let everything through.
  if (session?.pausedAt) return;

  const lock = denialLocks?.[String(tabId)];
  if (lock && url && !url.startsWith(BLOCKED_PAGE)) {
    let host = "";
    try { host = new URL(url).hostname; } catch {}
    const sameHost = host && (host === lock.host || host.endsWith("." + lock.host));
    if (sameHost) {
      const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(url)}&host=${encodeURIComponent(lock.host)}&task=${encodeURIComponent(lock.task || "")}&denied=1`;
      try { await chrome.tabs.update(tabId, { url: target }); } catch {}
      return;
    }
    if (host) {
      // Navigated away from the locked host → the lock is stale, drop it.
      const next = { ...denialLocks };
      delete next[String(tabId)];
      await setState({ denialLocks: next });
    }
  }

  const blocked = shouldBlock(url, state);
  if (!blocked) return;

  const key = `${tabId}:${url}`;
  if (pendingEvals.has(key)) return;
  pendingEvals.set(key, true);

  try {
    const tabTitle = await reliableTitle(tabId, url);
    const r = await evaluateSiteRelevance({ domain: blocked.host, task: blocked.task, url, tabTitle });
    if (r.approved) {
      await grantTempAllow(blocked.host, r.reason);
      await logEvent("block_approved", { host: blocked.host, mode: "auto", reason: r.reason });
    } else {
      await logEvent("block_attempt", { host: blocked.host, task: blocked.task, url, tabTitle, aiReason: r.reason || "" });
      const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(url)}&host=${encodeURIComponent(blocked.host)}&task=${encodeURIComponent(blocked.task)}&title=${encodeURIComponent(tabTitle)}&askReason=${encodeURIComponent(r.reason || "")}`;
      try { await chrome.tabs.update(tabId, { url: target }); } catch {}
    }
  } finally {
    pendingEvals.delete(key);
  }
}

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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { denialLocks } = await getState();
  if (denialLocks?.[String(tabId)]) {
    const next = { ...denialLocks };
    delete next[String(tabId)];
    await setState({ denialLocks: next });
  }
});

// ─── Drift detection ──────────────────────────────────────────────────────
// A tab's URL or title changing is the real drift signal, so we react to it
// directly instead of only polling. A per-tab cooldown coalesces the flurry of
// title updates a page fires while loading into a single check, and picks up the
// settled title rather than a transient "Loading…".
const DRIFT_EVENT_COOLDOWN_MS = 2000;
const driftDebounce = new Map(); // tabId -> pending timeout

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url == null && changeInfo.title == null) return;
  const prev = driftDebounce.get(tabId);
  if (prev) clearTimeout(prev);
  driftDebounce.set(tabId, setTimeout(() => {
    driftDebounce.delete(tabId);
    driftCheckTab(tabId).catch(() => {});
  }, DRIFT_EVENT_COOLDOWN_MS));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const t = driftDebounce.get(tabId);
  if (t) { clearTimeout(t); driftDebounce.delete(tabId); }
});

// Is drift enforcement live right now? (session running, not paused, not on a
// Pomodoro break, drift enabled.)
async function driftActive(state) {
  const { session, driftCheckEnabled } = state;
  const { pomodoroEnabled, pomodoroWorkMin, pomodoroBreakMin } = resolveSettings(state);
  if (!driftCheckEnabled || !session || session.pausedAt) return false;
  if (pomodoroEnabled && session.startedAt) {
    const { phase } = getPomoPhase(sessionElapsed(session), pomodoroWorkMin, pomodoroBreakMin);
    if (phase === "break") return false;
  }
  return true;
}

// Event-driven check for a single tab, fired once its changes settle.
async function driftCheckTab(tabId) {
  const state = await getState();
  if (!(await driftActive(state))) return;
  const { session, tempAllow } = state;
  if (!tempAllow || Object.keys(tempAllow).length === 0) return;

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab || !tab.url) return;

  const g = await chrome.storage.session.get(["driftSeen", "driftStrikes"]).catch(() => ({}));
  const seen = g?.driftSeen || {};
  const strikes = g?.driftStrikes || {};
  await evaluateTabDrift(tab, { session, tempAllow, now: Date.now(), seen, strikes });
  try { await chrome.storage.session.set({ driftSeen: seen, driftStrikes: strikes }); } catch {}
}

// Polling backstop. Events cover most changes, but this catches anything they
// miss and — crucially — supplies the second read that confirms a strike when an
// off-task page then sits still and fires no further events.
async function driftSweep() {
  const state = await getState();
  if (!(await driftActive(state))) return;
  const { session, tempAllow, driftCheckSeconds } = state;
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

  let seen = {};
  let strikes = {};
  try {
    const g = await chrome.storage.session.get(["driftSeen", "driftStrikes"]);
    seen = g?.driftSeen || {};
    strikes = g?.driftStrikes || {};
  } catch {}

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    await evaluateTabDrift(tab, { session, tempAllow, now, seen, strikes });
  }

  try { await chrome.storage.session.set({ driftSeen: seen, driftStrikes: strikes }); } catch {}
}

// Re-judge one temp-allowed tab. Shared by both the event and poll paths so the
// dedup + two-strike revocation semantics are identical no matter what triggered
// it. Mutates ctx.seen / ctx.strikes; redirects to the blocked page on the
// second consecutive off-task read.
async function evaluateTabDrift(tab, ctx) {
  const { session, tempAllow, now, seen, strikes } = ctx;
  let host = "";
  try { host = new URL(tab.url).hostname; } catch { return; }
  const ta = activeTempAllow(tempAllow, host);
  if (!ta) return;

  // Grace: the user just deliberately justified this site. Leave it alone
  // until the window passes, then normal strike-based drift resumes.
  if ((ta.source === "reason" || ta.source === "override") &&
      ta.grantedAt && now - ta.grantedAt < DRIFT_GRACE_MS) return;

  let title = tab.title || "";
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.title
    });
    if (res && typeof res.result === "string") title = res.result;
  } catch {}

  // Per-host signature of the last url/title we sent to the AI. We only pay for
  // an evaluation when the page has changed since then.
  const sig = `${tab.url}\n${title}`;
  if (seen[host] === sig) return;

  const r = await evaluateTitle({
    domain: host,
    task: session.taskText || "",
    tabTitle: title,
    approvalReason: ta.reason || ""
  });
  if (!r.onTopic) {
    const n = (strikes[host] || 0) + 1;
    if (n < DRIFT_STRIKES_TO_REVOKE) {
      // First strike: probably a flaky model roll or a transient page title.
      // Record it and wait for the next read to confirm before revoking.
      strikes[host] = n;
      return;
    }
    delete strikes[host];
    const cur = (await getState()).tempAllow || {};
    const next = { ...cur };
    delete next[ta.domain];
    await setState({ tempAllow: next });
    delete seen[host];
    await logEvent("drift_revoked", { host, task: session.taskText || "", reason: r.reason });
    const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(tab.url)}&host=${encodeURIComponent(host)}&task=${encodeURIComponent(session.taskText || "")}&drift=${encodeURIComponent(r.reason || "off-task")}`;
    try { await chrome.tabs.update(tab.id, { url: target }); } catch {}
  } else {
    strikes[host] = 0; // back on task — the streak resets
    seen[host] = sig;  // passed — remember it so we skip until it changes
  }
}

async function checkLongSession() {
  const { session } = await getState();
  if (!session?.startedAt) return;

  const elapsed = sessionElapsed(session);
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
      await logEvent("session_end", { task: session.taskText || "", duration_ms: sessionElapsed(session), reason: "long_session_timeout" });
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
      await logEvent("session_end", { task: session.taskText || "", duration_ms: sessionElapsed(session), reason: "long_session_user_ended" });
    }
    await setState({ session: null, tempAllow: {}, denialLocks: {} });
  }
});

// ─── Scheduled sessions ───────────────────────────────────────────────────
// Once a minute, auto-start a focus session for any schedule that is due.
async function checkSchedules() {
  const { schedules, session } = await getState();
  if (!schedules?.length) return;

  const now = new Date();
  const due = dueSchedules(schedules, now);
  if (!due.length) return;

  // Stamp every due schedule as fired today so it can't retry this minute or
  // re-fire later in the day, even if we end up not starting a session below.
  const today = dateKey(now);
  const firedIds = new Set(due.map((s) => s.id));
  const next = schedules.map((s) => firedIds.has(s.id) ? { ...s, lastFired: today } : s);
  await setState({ schedules: next });

  // Don't interrupt a session that's already running — the schedule is marked
  // fired above, so it simply won't start a competing one.
  if (session) return;

  const pick = due[0];
  const taskText = (pick.taskText || "").trim();
  if (!taskText) return;

  await setState({
    session: { taskText, startedAt: Date.now(), source: "schedule" },
    tempAllow: {},
    denialLocks: {}
  });
  await chrome.storage.session.remove("pomoLastPhase").catch(() => {});
  await logEvent("session_start", { task: taskText, source: "schedule" });

  chrome.notifications.create(`locus-sched-${pick.id}-${today}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Locus · Scheduled session",
    message: `Focus session started: ${taskText}`,
  });
}

async function tryCalendarSync() {
  const { calendar } = await getState();
  if (!calendar?.feeds?.length) return;
  try {
    await fetchUpcomingEvents(14);
  } catch {}
}

// ─── Lockdown ───────────────────────────────────────────────────────────────
// A commitment device: during the configured window, force-run a locked
// Pomodoro session on one of the allowed tasks and undo any attempt to pause,
// end, or de-timer it. Runs on the 15s drift tick + startup, so a session
// cleared by hand (or a slept worker) is re-asserted within seconds.
//
// The latch is `lockCommit`, not `lockdown.enabled`: once we're locked in for
// the day, only the clock (reaching `until`) releases us. The only real escape
// is disabling the whole extension at chrome://extensions — we can't stop that,
// and shouldn't pretend to.
async function enforceLockdown() {
  const state = await getState();
  const now = Date.now();
  const lock = state.lockdown;
  let commit = state.lockCommit;

  // Enter the window with no live latch → arm one for the rest of today's window.
  if (!commit && inLockWindow(lock, new Date())) {
    const { start, end } = windowBounds(lock, new Date());
    const task = allowedTask(lock, lock.lastTask) ? lock.lastTask : (lock.tasks[0] || "Focus");
    commit = { until: end, startedAt: start, task };
    // Record end of any session we're displacing so its focus time is logged.
    if (state.session?.startedAt) {
      await logEvent("session_end", {
        task: state.session.taskText || "",
        duration_ms: sessionElapsed(state.session),
        reason: "lockdown_takeover"
      });
    }
    await setState({ lockCommit: commit });
    await logEvent("session_start", { task, source: "lockdown" });
  }

  if (!commit) return; // no lock in force

  // Past the release time → tear the whole thing down.
  if (now >= commit.until) {
    if (state.session?.locked) {
      await logEvent("session_end", {
        task: state.session.taskText || "",
        duration_ms: sessionElapsed(state.session),
        reason: "lockdown_complete"
      });
    }
    await setState({ lockCommit: null, session: null, tempAllow: {}, denialLocks: {} });
    await chrome.storage.session.remove(["pomoLastPhase", "driftSeen", "driftStrikes"]).catch(() => {});
    return;
  }

  // Latch is live → make reality match it.
  const patch = {};
  const s = state.session;
  if (!s || !s.locked || !s.startedAt) {
    // Missing or replaced by a non-locked session → (re)create the locked one.
    patch.session = {
      taskText: commit.task, startedAt: commit.startedAt,
      source: "lockdown", locked: true, lockedUntil: commit.until
    };
    patch.tempAllow = {};
    patch.denialLocks = {};
  } else {
    const ns = { ...s };
    let changed = false;
    if (s.pausedAt) { ns.pausedAt = null; changed = true; }                 // no pausing out
    if (s.lockedUntil !== commit.until) { ns.lockedUntil = commit.until; changed = true; }
    if (!allowedTask(lock, s.taskText)) { ns.taskText = commit.task; changed = true; } // task must stay in the set
    if (changed) patch.session = ns;
  }
  // The timer, its lengths, harshness and the allowlist come from the
  // lockdown's own overrides for the duration (resolveSettings). We deliberately
  // don't write them into the global keys: nothing to restore afterwards, and a
  // worker that dies mid-window can't strand the user's normal settings.
  if (Object.keys(patch).length) await setState(patch);
}

// ─── Message API ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "getState": {
          // `effective` = the settings in force right now (lockdown overrides
          // applied). Pages that *render behavior* read it; the dashboard's
          // global settings pane keeps reading the raw keys so it still edits
          // the globals rather than the override.
          const state = await getState();
          sendResponse({ ...state, effective: resolveSettings(state) }); break;
        }

        case "startSession": {
          const taskText = (msg.taskText || "").trim();
          if (!taskText) { sendResponse({ ok: false, error: "Task required" }); break; }
          const source = ["calendar", "quick"].includes(msg.source) ? msg.source : "manual";
          const patch = {
            session: { taskText, startedAt: Date.now(), source },
            tempAllow: {},
            denialLocks: {}
          };
          // Quick Focus picks a Pomodoro length (or "No limit" = off) as it starts.
          if (msg.pomodoro && typeof msg.pomodoro === "object") {
            patch.pomodoroEnabled = !!msg.pomodoro.enabled;
            if (POMO_WORK_OPTIONS.includes(msg.pomodoro.workMin)) {
              patch.pomodoroWorkMin = msg.pomodoro.workMin;
            }
          }
          await setState(patch);
          await pushRecentTask(taskText);
          await chrome.storage.session.remove(["pomoLastPhase", "driftSeen", "driftStrikes"]).catch(() => {});
          await logEvent("session_start", { task: taskText, source });
          sendResponse({ ok: true });
          break;
        }

        case "updateTask": {
          const { session, lockdown, lockCommit } = await getState();
          if (!session) { sendResponse({ ok: false }); break; }
          const taskText = (msg.taskText || "").trim();
          if (!taskText) { sendResponse({ ok: false, error: "empty" }); break; }
          if (session.locked && session.lockedUntil > Date.now()) {
            // Locked in → you may only swap among the allowed tasks.
            if (!allowedTask(lockdown, taskText)) {
              sendResponse({ ok: false, error: "locked", locked: true }); break;
            }
            await setState({
              session: { ...session, taskText },
              // Keep the latch + remembered choice in sync so a self-heal
              // restores the task you're actually on, not the old one.
              lockCommit: lockCommit ? { ...lockCommit, task: taskText } : lockCommit,
              lockdown: { ...lockdown, lastTask: taskText }
            });
          } else {
            await setState({ session: { ...session, taskText } });
          }
          await chrome.storage.session.remove(["driftSeen", "driftStrikes"]).catch(() => {});
          sendResponse({ ok: true });
          break;
        }

        case "stopSession": {
          const { session } = await getState();
          if (session?.locked && session.lockedUntil > Date.now()) {
            // Can't end a lock from inside the window.
            sendResponse({ ok: false, locked: true, until: session.lockedUntil }); break;
          }
          if (session?.startedAt) {
            await logEvent("session_end", {
              task: session.taskText || "",
              duration_ms: sessionElapsed(session)
            });
          }
          await setState({ session: null, tempAllow: {}, denialLocks: {} });
          await chrome.storage.session.remove(["pomoLastPhase", "driftSeen", "driftStrikes"]).catch(() => {});
          sendResponse({ ok: true });
          break;
        }

        case "togglePause": {
          const { session } = await getState();
          if (!session?.startedAt) { sendResponse({ ok: false }); break; }
          if (session.locked && session.lockedUntil > Date.now()) {
            // No pausing your way out of a lock.
            sendResponse({ ok: false, locked: true }); break;
          }
          let next;
          if (session.pausedAt) {
            const pausedMs = (session.pausedMs || 0) + (Date.now() - session.pausedAt);
            next = { ...session, pausedAt: null, pausedMs };
          } else {
            next = { ...session, pausedAt: Date.now() };
          }
          await setState({ session: next });
          await logEvent(next.pausedAt ? "session_pause" : "session_resume", { task: session.taskText || "" });
          sendResponse({ ok: true, paused: !!next.pausedAt });
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
            reason: msg.reason,
            url: msg.url || "",
            tabTitle: msg.title || ""
          });
          const tabId = sender?.tab?.id;
          if (r.approved) {
            await grantTempAllow(msg.host, r.reason, "reason");
            await logEvent("block_approved", { host: msg.host, mode: "reason", reason: r.reason });
            if (tabId != null) await clearDenialLock(tabId);
          } else if (!r.transient) {
            // Only lock the tab on a real denial — not a transient network failure.
            await logEvent("block_denied", { host: msg.host, reason: r.reason });
            if (tabId != null) await setDenialLock(tabId, msg.host, session.taskText || "", r.reason);
          }
          sendResponse(r);
          break;
        }

        case "hideSite": {
          const domain = (msg.domain || "").trim().toLowerCase().replace(/^www\./, "");
          if (domain) {
            const { hiddenSites } = await getState();
            if (!hiddenSites.includes(domain)) {
              await setState({ hiddenSites: [...hiddenSites, domain] });
              await logEvent("pill_hidden", { host: domain });
            }
          }
          sendResponse({ ok: true });
          break;
        }

        case "tryOverride": {
          const { overrideCode } = await getState();
          const ok = (msg.code || "").trim() === (overrideCode || "").trim() && !!overrideCode;
          if (ok) {
            await grantTempAllow(msg.host, "override code", "override");
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


// Remember a just-started task for the quick-focus pill. Case-insensitive dedup
// (so "Work" typed twice with different casing doesn't pile up) keeps the list
// tidy; newest first, capped so it can't grow without bound.
async function pushRecentTask(taskText) {
  const t = (taskText || "").trim();
  if (!t) return;
  const { recentTasks } = await getState();
  const lower = t.toLowerCase();
  const next = [t, ...(recentTasks || []).filter((x) => (x || "").toLowerCase() !== lower)].slice(0, 8);
  await setState({ recentTasks: next });
}

async function grantTempAllow(host, reason = "", source = "auto") {
  const { tempAllow, tempAllowMins } = await getState();
  const next = { ...(tempAllow || {}) };
  next[host] = {
    exp: Date.now() + (Number(tempAllowMins) || 10) * 60_000,
    reason,
    source,
    grantedAt: Date.now()
  };
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
