// Full-tab dashboard. Sidebar: Start / Settings / Connectors / Analytics.

import { PROMPT_DEFAULTS } from "./lib/ai.js";
import { computeSummary, clearAnalytics } from "./lib/analytics.js";
import { fmtElapsed, fmtCountdown, escapeHtml } from "./lib/format.js";
import { getPomoPhase, sessionElapsed, isPaused } from "./lib/pomodoro.js";
import { DAY_LABELS, makeScheduleId } from "./lib/schedule.js";
import { lockConfigError, inLockWindow, nextWindowStart, windowBounds } from "./lib/lockdown.js";

function send(msg) { return new Promise((res) => chrome.runtime.sendMessage(msg, res)); }
async function getAll() { return await send({ type: "getState" }); }
async function save(patch) { await chrome.storage.local.set(patch); }

function fmtMinsHuman(secs) {
  if (!secs) return "0m";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

// ── Pane navigation ────────────────────────────────────────────────────
function setPane(name) {
  document.querySelectorAll(".side-nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.pane === name);
  });
  document.querySelectorAll(".pane").forEach((p) => {
    p.classList.toggle("active", p.id === `pane-${name}`);
  });
  if (name === "analytics") renderAnalytics();
  if (name === "start") renderStart();
  if (name === "connectors") renderConnectors();
  if (name === "settings") renderSettings();
  if (name === "schedule") renderSchedule();
}
document.querySelectorAll(".side-nav button").forEach((b) => {
  b.addEventListener("click", () => setPane(b.dataset.pane));
});

// ── Start pane ─────────────────────────────────────────────────────────
let timerInterval = null;

function dayBucketLabel(date, today, tomorrow) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (d.getTime() === today.getTime()) return "TODAY";
  if (d.getTime() === tomorrow.getTime()) return "TOMORROW";
  const wk = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getDay()];
  const mo = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()];
  return `${wk} ${mo} ${d.getDate()}`;
}

function fmtTime(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`;
}

function eventCard(ev, taskTextForSession) {
  const card = document.createElement("div");
  card.className = "event-card";
  const icon = document.createElement("div");
  icon.className = "event-icon";
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="14" y2="17"></line></svg>`;
  const body = document.createElement("div");
  body.className = "event-body";
  const title = document.createElement("div");
  title.className = "event-title";
  title.textContent = ev.title;
  const sub = document.createElement("div");
  sub.className = "event-sub";
  sub.textContent = ev.source || "";
  body.appendChild(title); body.appendChild(sub);
  const time = document.createElement("div");
  time.className = "event-time";
  try {
    const d = new Date(ev.start);
    time.textContent = ev.allDay ? "all day" : fmtTime(d);
  } catch { time.textContent = ""; }

  card.appendChild(icon); card.appendChild(body); card.appendChild(time);
  card.addEventListener("click", async () => {
    await send({ type: "startSession", taskText: taskTextForSession, source: "calendar" });
    renderStart();
  });
  return card;
}

async function renderStart() {
  const state = await getAll();
  const idleEl = document.getElementById("startIdle");
  const activeEl = document.getElementById("startActive");

  if (state.session) {
    idleEl.style.display = "none";
    activeEl.style.display = "block";
    const taskText = state.session.taskText || "";
    document.getElementById("activeTaskLine").textContent = taskText
      ? `Task: ${taskText}` : "No specific task.";

    // Effective, not global: a running lockdown supplies its own timer settings.
    const eff = state.effective || state;
    const pomodoroEnabled = !!eff.pomodoroEnabled;
    const pomoWorkMin = eff.pomodoroWorkMin || 25;
    const pomoBreakMin = eff.pomodoroBreakMin || 5;
    const session = state.session;
    const paused  = isPaused(session);
    const timerEl = document.getElementById("activeTimer");
    const phaseEl = document.getElementById("activePomoPhase");
    document.getElementById("activePauseBtn").textContent = paused ? "Resume" : "Pause";

    const tick = () => {
      const elapsed = sessionElapsed(session);
      if (pomodoroEnabled) {
        const { phase, remaining, round } = getPomoPhase(elapsed, pomoWorkMin, pomoBreakMin);
        timerEl.textContent = fmtCountdown(remaining);
        phaseEl.style.display = "";
        if (paused) {
          phaseEl.textContent = "Paused";
          phaseEl.style.color = "var(--ink-soft)";
        } else {
          phaseEl.textContent = phase === "work" ? `Work · Round ${round}` : "Break";
          phaseEl.style.color = phase === "break" ? "var(--accent)" : "var(--ink-soft)";
        }
      } else {
        timerEl.textContent = fmtElapsed(elapsed);
        phaseEl.style.display = paused ? "" : "none";
        if (paused) { phaseEl.textContent = "Paused"; phaseEl.style.color = "var(--ink-soft)"; }
      }
    };
    tick();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = paused ? null : setInterval(tick, 1000);

    const events = (state.analytics?.events) || [];
    let attempts = 0, approved = 0;
    for (const ev of events) {
      if (!ev.ts || ev.ts < session.startedAt) continue;
      if (ev.type === "block_attempt") attempts++;
      else if (ev.type === "block_approved") approved++;
    }
    document.getElementById("activeSummary").textContent =
      attempts || approved
        ? `${attempts} block${attempts === 1 ? "" : "s"} · ${approved} approved`
        : "No blocks yet this session.";
    return;
  }

  idleEl.style.display = "block";
  activeEl.style.display = "none";
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  // Upcoming list
  const list = document.getElementById("upcomingList");
  const cal = state.calendar || {};
  const feeds = cal.feeds || [];
  const upcoming = (cal.upcoming || []).filter((e) => {
    const ts = Date.parse(e.start || "");
    return Number.isFinite(ts) && ts >= Date.now() - 60_000;
  });

  list.className = "";
  list.innerHTML = "";

  if (!feeds.length) {
    list.className = "upcoming-empty";
    const span = document.createElement("span");
    span.innerHTML = `No calendar feeds yet. <a id="goConnectors">Add one in Connectors →</a>`;
    list.appendChild(span);
    list.querySelector("#goConnectors").addEventListener("click", (e) => {
      e.preventDefault(); setPane("connectors");
    });
    return;
  }
  if (!upcoming.length) {
    list.className = "upcoming-empty";
    list.textContent = cal.lastSyncedAt
      ? "No upcoming events in the next 14 days."
      : "Click \"Sync now\" in Connectors to fetch your calendar.";
    return;
  }

  // Group by day
  const today = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

  const byDay = new Map();
  for (const ev of upcoming) {
    const d = new Date(ev.start);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, { date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), items: [] });
    byDay.get(key).items.push(ev);
  }

  for (const { date, items } of byDay.values()) {
    const group = document.createElement("div");
    group.className = "day-group";
    const header = document.createElement("div");
    header.className = "day-header";
    header.textContent = dayBucketLabel(date, today, tomorrow);
    group.appendChild(header);
    for (const ev of items) {
      const taskText = ev.source ? `${ev.title} (${ev.source})` : ev.title;
      group.appendChild(eventCard(ev, taskText));
    }
    list.appendChild(group);
  }
}

document.getElementById("startSessionBtn").addEventListener("click", async () => {
  const v = document.getElementById("startTaskInput").value.trim();
  if (!v) { document.getElementById("startTaskInput").focus(); return; }
  await send({ type: "startSession", taskText: v, source: "manual" });
  renderStart();
});
document.getElementById("startTaskInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("startSessionBtn").click();
});
document.getElementById("activePauseBtn").addEventListener("click", async () => {
  await send({ type: "togglePause" });
  renderStart();
});
document.getElementById("activeEndBtn").addEventListener("click", async () => {
  await send({ type: "stopSession" });
  renderStart();
});
// ── Settings pane ──────────────────────────────────────────────────────
async function renderSettings() {
  const state = await getAll();
  document.getElementById("theme").value = state.theme || "system";
  document.getElementById("harshness").value = state.harshness || "Standard";
  document.getElementById("tempAllowMins").value = String(state.tempAllowMins ?? 10);
  document.getElementById("quickFocusButton").checked = state.quickFocusButton !== false;
  document.getElementById("playSoundOnBlock").checked = !!state.playSoundOnBlock;
  document.getElementById("driftCheckEnabled").checked = !!state.driftCheckEnabled;
  document.getElementById("pomodoroEnabled").checked = !!state.pomodoroEnabled;
  document.getElementById("pomoWorkMin").value = String(state.pomodoroWorkMin ?? 25);
  document.getElementById("pomoBreakMin").value = String(state.pomodoroBreakMin ?? 5);
  syncPomoLengthUI(!!state.pomodoroEnabled);
  document.getElementById("overrideCode").value = state.overrideCode || "";
  document.getElementById("promptReason").value = state.prompts?.reason || "";
  document.getElementById("promptSite").value = state.prompts?.site || "";
  document.getElementById("promptTitle").value = state.prompts?.title || "";
  renderAllowedChips(state);
}

// ── Chip lists (auto-save on add/remove) ───────────────────────────────
function chipList(container, items, onRemove) {
  container.innerHTML = "";
  items.forEach((item, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.appendChild(document.createTextNode(item));
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕"; x.title = "Remove";
    x.addEventListener("click", () => onRemove(i));
    chip.appendChild(x);
    container.appendChild(chip);
  });
}

async function renderAllowedChips(state) {
  const s = state || await getAll();
  chipList(document.getElementById("allowedChips"), s.alwaysAllowed || [], async (i) => {
    const c = await getAll();
    await save({ alwaysAllowed: (c.alwaysAllowed || []).filter((_, idx) => idx !== i) });
    renderAllowedChips();
  });
}

function normDomain(v) {
  return (v || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

async function addAllowed() {
  const inp = document.getElementById("allowedInput");
  const d = normDomain(inp.value);
  if (!d) return;
  const c = await getAll();
  const list = c.alwaysAllowed || [];
  if (!list.some((x) => x.toLowerCase() === d)) await save({ alwaysAllowed: [...list, d] });
  inp.value = "";
  renderAllowedChips();
}

document.getElementById("allowedAdd").addEventListener("click", addAllowed);
document.getElementById("allowedInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addAllowed(); });

// The Schedule pane shows only a digest of the lockdown plus its enable switch;
// the setup itself lives in a modal. While a window is actually running both
// freeze — editing can't spring you early, so pretending otherwise would lie.
async function renderLockdown() {
  const state = await getAll();
  const lock = state.lockdown || {};
  const locked = !!(state.session?.locked && state.session.lockedUntil > Date.now());
  lockIsLive = locked;
  document.getElementById("lockdownEnabled").checked = !!lock.enabled;
  document.getElementById("lockdownEnabled").disabled = locked;
  document.getElementById("lockEditBtn").disabled = locked;
  renderLockSummary(lock);
  showLockStatus(lock, locked ? state.session.lockedUntil : 0);
  if (locked) closeLockModal(); // a lock that engages mid-edit closes the form
}

// One-line digest of the window plus a second line for the strictness it
// imposes, so the pane says what the lockdown does without unfolding it.
function renderLockSummary(lock) {
  const el = document.getElementById("lockSummary");
  el.textContent = "";
  if (lockConfigError(lock)) {
    el.textContent = "Not set up yet.";
    return;
  }
  const n = lock.tasks.length;
  const main = document.createElement("div");
  main.textContent = `${fmtSchedTime(hm(lock.startHour, lock.startMin))} – ` +
    `${fmtSchedTime(hm(lock.endHour, lock.endMin))} · ${fmtSchedDays(lock.days)} · ` +
    `${n} task${n === 1 ? "" : "s"}`;

  const ov = lock.overrides || {};
  const sub = document.createElement("div");
  sub.className = "lock-sum-strict";
  sub.textContent = [
    `${ov.harshness || "Standard"} harshness`,
    ov.pomodoroEnabled ? `${ov.pomodoroWorkMin ?? 25}/${ov.pomodoroBreakMin ?? 5} pomodoro` : "no timer",
    Array.isArray(ov.alwaysAllowed)
      ? `${ov.alwaysAllowed.length} allowed domain${ov.alwaysAllowed.length === 1 ? "" : "s"}`
      : "normal allowlist"
  ].join(" · ");

  el.append(main, sub);
}

// The lock can engage (or release) while this page sits open — the config is
// frozen by the running window, not by whatever the form looked like at render
// time. Re-render on that transition so the UI never lies about being editable.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (!("session" in changes) && !("lockCommit" in changes)) return;
  const state = await getAll();
  const locked = !!(state.session?.locked && state.session.lockedUntil > Date.now());
  if (locked !== lockIsLive) renderLockdown();
});

// "HH:MM" for a 24h time input. Blank for a missing/garbage value so an
// unfilled window doesn't masquerade as a real 00:00.
function hm(h, m) {
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function fmtClock(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}

// Everything on this pane auto-saves the moment it changes — no Save button.
document.getElementById("theme").addEventListener("change", (event) => {
  const selected = event.target.value;
  if (selected === "system" || selected === "light" || selected === "dark") {
    document.documentElement.setAttribute("data-theme", selected);
    save({ theme: selected });
  }
});

document.getElementById("harshness").addEventListener("change", (e) => save({ harshness: e.target.value }));

document.getElementById("tempAllowMins").addEventListener("change", async (e) => {
  const n = parseInt(e.target.value, 10);
  if (Number.isFinite(n) && n > 0) { e.target.value = String(n); await save({ tempAllowMins: n }); }
  else { const c = await getAll(); e.target.value = String(c.tempAllowMins ?? 10); }
});

document.getElementById("quickFocusButton").addEventListener("change", (e) => save({ quickFocusButton: e.target.checked }));
document.getElementById("playSoundOnBlock").addEventListener("change", (e) => save({ playSoundOnBlock: e.target.checked }));
document.getElementById("driftCheckEnabled").addEventListener("change", (e) => save({ driftCheckEnabled: e.target.checked }));

// Override code — debounced auto-save while typing.
let overrideTimer = null;
document.getElementById("overrideCode").addEventListener("input", (e) => {
  clearTimeout(overrideTimer);
  const v = e.target.value;
  overrideTimer = setTimeout(() => save({ overrideCode: v }), 400);
});

// Pomodoro length inputs only show when the timer is on.
function syncPomoLengthUI(pomodoroOn) {
  document.querySelectorAll(".pomo-len").forEach((r) => { r.hidden = !pomodoroOn; });
}

document.getElementById("pomodoroEnabled").addEventListener("change", (e) => {
  syncPomoLengthUI(e.target.checked);
  save({ pomodoroEnabled: e.target.checked });
});

// A minutes box: accept any positive integer, else snap back to the stored value.
function wirePomoLen(id, key, def) {
  document.getElementById(id).addEventListener("change", async (e) => {
    const n = parseInt(e.target.value, 10);
    if (Number.isFinite(n) && n > 0) { e.target.value = String(n); await save({ [key]: n }); }
    else { const c = await getAll(); e.target.value = String(c[key] ?? def); }
  });
}
wirePomoLen("pomoWorkMin", "pomodoroWorkMin", 25);
wirePomoLen("pomoBreakMin", "pomodoroBreakMin", 5);

// Selected days for the lockdown config, kept across settings re-renders.
let lockDaysSel = new Set();
// Mirrors "a lock window is actually running right now".
let lockIsLive = false;

// Draft allowlist while the modal is open, and the global list it was seeded
// from the first time the user asks for a tighter one.
let lockAllowDraft = [];
let lockGlobalAllowed = [];

// Read the modal into a config object. Note it never touches `enabled` — the
// switch on the card owns that — so a save can't arm a lockdown by itself.
// Unparseable times become null so lockConfigError() rejects them instead of
// silently reading as midnight.
function readLockForm(prev) {
  const time = (id) => {
    const [h, m] = String(document.getElementById(id).value || "").split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? [h, m] : [null, null];
  };
  const num = (id, def) => {
    const n = parseInt(document.getElementById(id).value, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const [sh, sm] = time("lockStart");
  const [eh, em] = time("lockEnd");
  const tasks = document.getElementById("lockTasks").value
    .split("\n").map((t) => t.trim()).filter(Boolean);
  return {
    ...prev,
    startHour: sh, startMin: sm, endHour: eh, endMin: em,
    days: [...lockDaysSel].sort((a, b) => a - b),
    tasks,
    // Drop a remembered task that's no longer offered.
    lastTask: tasks.includes(prev?.lastTask) ? prev.lastTask : "",
    overrides: {
      ...(prev?.overrides || {}),
      pomodoroEnabled: document.getElementById("lockPomoEnabled").checked,
      pomodoroWorkMin: num("lockPomoWork", 25),
      pomodoroBreakMin: num("lockPomoBreak", 5),
      harshness: document.getElementById("lockHarshness").value,
      // null, not [], means "inherit the normal allowlist" — an empty array is
      // a real (and very strict) choice.
      alwaysAllowed: document.getElementById("lockAllowCustom").checked ? [...lockAllowDraft] : null
    }
  };
}

// One status line, always saying something true: why it can't arm, when it
// next fires, or when the running window releases you.
function showLockStatus(lock, lockedUntil, override) {
  const el = document.getElementById("lockdownStatus");
  if (!el) return;
  if (override) { el.textContent = override; return; }
  if (lockedUntil) {
    el.textContent = `Locked in until ${fmtClock(lockedUntil)} — settings unfreeze when the window ends.`;
    return;
  }
  const err = lockConfigError(lock);
  if (err) { el.textContent = `Off — ${err.charAt(0).toLowerCase()}${err.slice(1)}`; return; }
  if (!lock.enabled) { el.textContent = "Set up. Flip the switch to arm it."; return; }
  const next = nextWindowStart(lock);
  el.textContent = next
    ? `On — next lockdown ${DAY_LABELS[next.getDay()]} ${fmtClock(next.getTime())}.`
    : "On.";
}

// Arming a window that contains right now latches the session immediately, for
// hours, with no way out. Both paths that can do that (the switch, and saving
// edits while it's already on) ask first. Returns false to abort.
function confirmImmediateLock(cfg) {
  if (!inLockWindow(cfg, new Date())) return true;
  const { end } = windowBounds(cfg, new Date());
  return confirm(
    `Right now is inside this window.\n\n` +
    `This locks you in until ${fmtClock(end)} today. You won't be able to pause, ` +
    `end, or edit the lockdown until then.\n\nStart it now?`
  );
}

// ── Lockdown modal ─────────────────────────────────────────────────────
// Transactional: the form edits a copy and only Save writes it, so a
// half-finished config can never reach storage and Cancel really cancels.
function openLockModal(lock, globalAllowed) {
  lockGlobalAllowed = globalAllowed || [];
  document.getElementById("lockStart").value = hm(lock.startHour, lock.startMin);
  document.getElementById("lockEnd").value = hm(lock.endHour, lock.endMin);
  document.getElementById("lockTasks").value = (lock.tasks || []).join("\n");
  lockDaysSel = new Set(lock.days || []);
  buildDayPicker(document.getElementById("lockDays"), lockDaysSel);

  const ov = lock.overrides || {};
  document.getElementById("lockPomoEnabled").checked = !!ov.pomodoroEnabled;
  document.getElementById("lockPomoWork").value = String(ov.pomodoroWorkMin ?? 25);
  document.getElementById("lockPomoBreak").value = String(ov.pomodoroBreakMin ?? 5);
  document.getElementById("lockHarshness").value = ov.harshness || "Standard";
  document.getElementById("lockAllowCustom").checked = Array.isArray(ov.alwaysAllowed);
  lockAllowDraft = Array.isArray(ov.alwaysAllowed) ? [...ov.alwaysAllowed] : [];

  syncLockModalSubs();
  renderLockAllowChips();
  setLockModalErr("");
  document.getElementById("lockModal").hidden = false;
  document.getElementById("lockStart").focus();
}

function closeLockModal() {
  document.getElementById("lockModal").hidden = true;
}

function setLockModalErr(msg) {
  document.getElementById("lockModalErr").textContent = msg || "";
}

// Sub-settings only make sense when their parent toggle is on.
function syncLockModalSubs() {
  document.querySelector(".lock-pomo-len").hidden =
    !document.getElementById("lockPomoEnabled").checked;
  document.querySelector(".lock-allow-wrap").hidden =
    !document.getElementById("lockAllowCustom").checked;
}

function renderLockAllowChips() {
  const box = document.getElementById("lockAllowChips");
  chipList(box, lockAllowDraft, (i) => {
    lockAllowDraft = lockAllowDraft.filter((_, idx) => idx !== i);
    renderLockAllowChips();
  });
  if (!lockAllowDraft.length) {
    box.innerHTML = `<div class="chips-empty">Nothing allowed — every site gets blocked while locked.</div>`;
  }
}

function addLockAllowed() {
  const inp = document.getElementById("lockAllowInput");
  const d = normDomain(inp.value);
  if (!d) return;
  if (!lockAllowDraft.some((x) => x.toLowerCase() === d)) lockAllowDraft.push(d);
  inp.value = "";
  renderLockAllowChips();
}

document.getElementById("lockEditBtn").addEventListener("click", async () => {
  if (lockIsLive) return;
  const state = await getAll();
  openLockModal(state.lockdown || {}, state.alwaysAllowed || []);
});
document.getElementById("lockModalClose").addEventListener("click", closeLockModal);
document.getElementById("lockModalCancel").addEventListener("click", closeLockModal);
document.getElementById("lockModal").addEventListener("click", (e) => {
  if (e.target.id === "lockModal") closeLockModal(); // click the backdrop, not the dialog
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("lockModal").hidden) closeLockModal();
});
document.getElementById("lockPomoEnabled").addEventListener("change", syncLockModalSubs);
document.getElementById("lockAllowCustom").addEventListener("change", (e) => {
  // Seed the tighter list from the normal one so it starts from something
  // sane rather than blocking literally everything by surprise.
  if (e.target.checked && !lockAllowDraft.length) lockAllowDraft = [...lockGlobalAllowed];
  syncLockModalSubs();
  renderLockAllowChips();
});
document.getElementById("lockAllowAdd").addEventListener("click", addLockAllowed);
document.getElementById("lockAllowInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addLockAllowed();
});

document.getElementById("lockModalSave").addEventListener("click", async () => {
  if (lockIsLive) return;
  const cur = await getAll();
  const draft = readLockForm(cur.lockdown);
  const err = lockConfigError(draft);
  if (err) { setLockModalErr(err); return; } // stays open, nothing lost
  // Only relevant when it's already armed: saving a new window while the switch
  // is on can start a lock right now just as flipping the switch would.
  if (draft.enabled && !confirmImmediateLock(draft)) return;
  await save({ lockdown: draft });
  closeLockModal();
  renderLockdown();
});

// The switch is the commit point. It validates first, so it can never sit "on"
// over a config that could never fire, and asks before an instant lock-in.
document.getElementById("lockdownEnabled").addEventListener("change", async (e) => {
  if (lockIsLive) return;
  const cur = await getAll();
  const next = { ...cur.lockdown, enabled: e.target.checked };

  if (!next.enabled) { // turning it off never needs a valid config
    await save({ lockdown: next });
    showLockStatus(next, 0);
    return;
  }

  const err = lockConfigError(next);
  if (err) {
    e.target.checked = false;
    showLockStatus({ ...next, enabled: false }, 0,
      `Can't enable yet — ${err.charAt(0).toLowerCase()}${err.slice(1)}`);
    return;
  }
  if (!confirmImmediateLock(next)) {
    e.target.checked = false;
    showLockStatus({ ...next, enabled: false }, 0,
      "Left off — set a window that starts later if you want to prepare first.");
    return;
  }

  await save({ lockdown: next });
  showLockStatus(next, 0);
});

// AI prompt overrides — debounced auto-save; a blank box means "use the default".
function wirePromptSave(id, key) {
  let t = null;
  document.getElementById(id).addEventListener("input", (e) => {
    clearTimeout(t);
    const v = e.target.value;
    t = setTimeout(async () => {
      const c = await getAll();
      await save({ prompts: { ...(c.prompts || {}), [key]: v } });
    }, 500);
  });
}
wirePromptSave("promptReason", "reason");
wirePromptSave("promptSite", "site");
wirePromptSave("promptTitle", "title");

document.getElementById("resetPrompts").addEventListener("click", async () => {
  document.getElementById("promptReason").value = PROMPT_DEFAULTS.reason;
  document.getElementById("promptSite").value = PROMPT_DEFAULTS.site;
  document.getElementById("promptTitle").value = PROMPT_DEFAULTS.title;
  await save({ prompts: { reason: PROMPT_DEFAULTS.reason, site: PROMPT_DEFAULTS.site, title: PROMPT_DEFAULTS.title } });
});

// ── Schedule pane ──────────────────────────────────────────────────────
// Selected days for the "new schedule" form, kept across re-renders.
const newSchedDays = new Set();

function buildDayPicker(container, selectedDays, onChange) {
  container.innerHTML = "";
  DAY_LABELS.forEach((lbl, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-btn" + (selectedDays.has(idx) ? " on" : "");
    b.textContent = lbl;
    b.addEventListener("click", () => {
      if (selectedDays.has(idx)) selectedDays.delete(idx);
      else selectedDays.add(idx);
      b.classList.toggle("on");
      if (onChange) onChange();
    });
    container.appendChild(b);
  });
}

function fmtSchedTime(t) {
  const [h, m] = String(t || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return t || "";
  const ap = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ap}`;
}

function fmtSchedDays(days) {
  const d = [...(days || [])].sort();
  if (d.length === 7) return "Every day";
  if (d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x))) return "Weekdays";
  return d.map((x) => DAY_LABELS[x]).join(", ");
}

async function renderSchedule() {
  const state = await getAll();
  const schedules = state.schedules || [];

  renderLockdown();
  buildDayPicker(document.getElementById("schDays"), newSchedDays);

  const listEl = document.getElementById("scheduleList");
  listEl.innerHTML = "";
  if (!schedules.length) {
    listEl.innerHTML = `<div class="muted tiny">No scheduled sessions yet — add one above.</div>`;
    return;
  }

  schedules.forEach((sch) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "10px";

    const row = document.createElement("div");
    row.className = "sched-item";

    const meta = document.createElement("div");
    meta.className = "sched-meta";
    meta.innerHTML =
      `<div class="sched-title">${escapeHtml(sch.taskText || "")}</div>` +
      `<div class="sched-sub">${escapeHtml(fmtSchedDays(sch.days))} · ${escapeHtml(fmtSchedTime(sch.time))}</div>`;

    const actions = document.createElement("div");
    actions.className = "sched-actions";

    const toggle = document.createElement("label");
    toggle.className = "toggle-row";
    toggle.title = sch.enabled ? "Enabled" : "Disabled";
    toggle.innerHTML =
      `<input type="checkbox" ${sch.enabled ? "checked" : ""}>` +
      `<span class="toggle-track"><span class="toggle-thumb"></span></span>`;
    toggle.querySelector("input").addEventListener("change", async (e) => {
      const cur = await getAll();
      const next = (cur.schedules || []).map((s) =>
        s.id === sch.id ? { ...s, enabled: e.target.checked } : s);
      await save({ schedules: next });
    });

    const del = document.createElement("button");
    del.className = "danger small";
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      const cur = await getAll();
      const next = (cur.schedules || []).filter((s) => s.id !== sch.id);
      await save({ schedules: next });
      renderSchedule();
    });

    actions.appendChild(toggle);
    actions.appendChild(del);
    row.appendChild(meta);
    row.appendChild(actions);
    card.appendChild(row);
    listEl.appendChild(card);
  });
}

document.getElementById("addSchedule").addEventListener("click", async () => {
  const task = document.getElementById("schTask").value.trim();
  const time = document.getElementById("schTime").value;
  const status = document.getElementById("schStatus");
  if (!task) { status.textContent = "Enter a task."; return; }
  if (!newSchedDays.size) { status.textContent = "Pick at least one day."; return; }
  if (!/^\d{2}:\d{2}$/.test(time)) { status.textContent = "Pick a time."; return; }

  const state = await getAll();
  const schedules = [...(state.schedules || []), {
    id: makeScheduleId(),
    taskText: task,
    days: [...newSchedDays].sort(),
    time,
    enabled: true,
    lastFired: ""
  }];
  await save({ schedules });

  document.getElementById("schTask").value = "";
  newSchedDays.clear();
  status.textContent = "Added.";
  setTimeout(() => status.textContent = "", 1500);
  renderSchedule();
});

// ── Connectors pane ────────────────────────────────────────────────────
async function renderConnectors() {
  const state = await getAll();
  const cal = state.calendar || {};
  const feeds = cal.feeds || [];
  const feedsDiv = document.getElementById("feeds");
  feedsDiv.innerHTML = "";
  if (!feeds.length) feedsDiv.innerHTML = `<div class="muted tiny">No iCal feeds yet — add one below.</div>`;
  feeds.forEach((feed, idx) => {
    const row = document.createElement("div"); row.className = "feed-row";
    const nm = document.createElement("input"); nm.type = "text"; nm.value = feed.name || "";
    nm.placeholder = "Name";
    const url = document.createElement("input"); url.type = "text"; url.value = feed.url || "";
    url.placeholder = "https://… .ics";
    const del = document.createElement("button"); del.className = "danger small"; del.textContent = "Remove";
    const persist = async () => {
      const cur = await getAll();
      const ccal = cur.calendar || {};
      const next = [...(ccal.feeds || [])];
      next[idx] = { name: nm.value.trim(), url: url.value.trim() };
      await save({ calendar: { ...ccal, feeds: next } });
    };
    nm.addEventListener("change", persist);
    url.addEventListener("change", persist);
    del.addEventListener("click", async () => {
      const cur = await getAll();
      const ccal = cur.calendar || {};
      const next = (ccal.feeds || []).filter((_, i) => i !== idx);
      await save({ calendar: { ...ccal, feeds: next } });
      renderConnectors();
    });
    row.appendChild(nm); row.appendChild(url); row.appendChild(del);
    feedsDiv.appendChild(row);
  });

  const errBox = document.getElementById("feedErrors");
  errBox.innerHTML = "";
  for (const err of (cal.lastErrors || [])) {
    const div = document.createElement("div");
    div.className = "feed-error";
    let hint = "";
    if (/HTTP 404/i.test(err.error)) hint = " — the URL is wrong. Make sure you copied the iCal/ICS export link, not the calendar's web page.";
    else if (/HTTP 401|HTTP 403/i.test(err.error)) hint = " — the URL needs auth. Use a public/secret iCal export link, not one that requires a login.";
    else if (/Failed to fetch|NetworkError|CORS/i.test(err.error)) hint = " — the server blocked the request (likely CORS). Try a different export URL.";
    div.textContent = `${err.name || err.url}: ${err.error}.${hint}`;
    errBox.appendChild(div);
  }

  const statusEl = document.getElementById("calStatus");
  if (cal.lastSyncedAt) {
    statusEl.textContent = `Last sync ${new Date(cal.lastSyncedAt).toLocaleString()} · ${(cal.upcoming || []).length} events`;
  } else {
    statusEl.textContent = feeds.length ? "Not synced yet — click Sync now." : "Add a feed to start.";
  }
}

document.getElementById("addFeed").addEventListener("click", async () => {
  const nm = document.getElementById("newFeedName").value.trim();
  const url = document.getElementById("newFeedUrl").value.trim();
  if (!url) return;
  const state = await getAll();
  const cal = state.calendar || {};
  const feeds = [...(cal.feeds || []), { name: nm || "Calendar", url }];
  await save({ calendar: { ...cal, feeds } });
  document.getElementById("newFeedName").value = "";
  document.getElementById("newFeedUrl").value = "";
  renderConnectors();
});

document.getElementById("calSync").addEventListener("click", async () => {
  const statusEl = document.getElementById("calStatus");
  statusEl.textContent = "Syncing…";
  const r = await send({ type: "calendar:sync" });
  if (!r?.ok) {
    statusEl.textContent = `Sync failed: ${r?.error || "unknown"}`;
  }
  renderConnectors();
});

// ── Analytics pane ─────────────────────────────────────────────────────
async function renderAnalytics() {
  const s = await computeSummary();
  document.getElementById("focusToday").textContent = fmtMinsHuman(s.focusToday);
  document.getElementById("focusWeek").textContent = fmtMinsHuman(s.focusWeek);
  document.getElementById("streak").textContent = `${s.streakDays}d`;
  document.getElementById("blockAttempts").textContent = String(s.blockAttempts);
  document.getElementById("blockApproved").textContent = String(s.blockApproved);
  document.getElementById("blockDenied").textContent = String(s.blockDenied);
  document.getElementById("driftRevoked").textContent = String(s.driftRevocations);
  document.getElementById("sessionsToday").textContent = String(s.sessionsToday);

  const entries = Object.entries(s.dailySeries).sort((a, b) => a[0].localeCompare(b[0]));
  document.getElementById("focusChart").innerHTML = svgFocusChart(entries);
  const totalSecs = entries.reduce((sum, [, v]) => sum + v, 0);
  const bestSecs = Math.max(0, ...entries.map(([, v]) => v));
  document.getElementById("focusChartCaption").textContent = totalSecs
    ? `${fmtMinsHuman(totalSecs)} focused over 14 days · best day ${fmtMinsHuman(bestSecs)}`
    : "No focus logged in the last 14 days.";

  document.getElementById("blockDonut").innerHTML = svgDonut(s.blockApproved, s.blockDenied);
  document.getElementById("topDomains").innerHTML = domainBars(s.topBlockedDomains);
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Vertical bar chart of focus seconds per day. Today is drawn full-strength;
// past days are dimmed so the eye lands on "how am I doing right now".
function svgFocusChart(entries) {
  const W = 700, H = 150, padT = 12, padB = 26, padX = 6;
  const innerH = H - padT - padB;
  const n = entries.length || 1;
  const slot = (W - padX * 2) / n;
  const bw = Math.min(24, slot * 0.6);
  const maxSec = Math.max(1, ...entries.map(([, v]) => v));
  const now = new Date();
  const todayK = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  let bars = "";
  entries.forEach(([key, secs], i) => {
    const [Y, M, D] = key.split("-").map(Number);
    const dt = new Date(Y, M - 1, D);
    const cx = padX + slot * i + slot / 2;
    const barH = secs > 0 ? Math.max(3, (secs / maxSec) * innerH) : 2;
    const y = padT + innerH - barH;
    const x = cx - bw / 2;
    const isToday = key === todayK;
    const fill = isToday ? "fill:var(--accent)" : "fill:var(--accent);opacity:.42";
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" style="${fill}"><title>${WEEKDAY[dt.getDay()]} ${MONTH[M - 1]} ${D} · ${fmtMinsHuman(secs)}</title></rect>`;
    const labStyle = isToday ? "fill:var(--ink);font-weight:600" : "fill:var(--ink-faint)";
    bars += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9" style="${labStyle}">${D}</text>`;
  });

  // Baseline
  const base = `<line x1="${padX}" y1="${padT + innerH + 0.5}" x2="${W - padX}" y2="${padT + innerH + 0.5}" style="stroke:var(--border)" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Focus minutes per day, last 14 days">${base}${bars}</svg>`;
}

// Approved-vs-denied donut. Center shows the approval rate.
function svgDonut(approved, denied) {
  const total = approved + denied;
  const r = 42, C = 2 * Math.PI * r;
  if (!total) {
    return `<svg viewBox="0 0 116 116" role="img" aria-label="No blocking decisions yet">
      <circle cx="58" cy="58" r="${r}" fill="none" style="stroke:var(--card-2)" stroke-width="14"/>
      <text x="58" y="62" text-anchor="middle" font-size="10" style="fill:var(--ink-faint)">No data</text></svg>`;
  }
  const appLen = (approved / total) * C;
  const denLen = C - appLen;
  const pct = Math.round((approved / total) * 100);
  return `<svg viewBox="0 0 116 116" role="img" aria-label="${pct}% of blocks approved">
    <circle cx="58" cy="58" r="${r}" fill="none" style="stroke:var(--card-2)" stroke-width="14"/>
    <g transform="rotate(-90 58 58)">
      <circle cx="58" cy="58" r="${r}" fill="none" style="stroke:var(--ok)" stroke-width="14" stroke-dasharray="${appLen.toFixed(2)} ${(C - appLen).toFixed(2)}"/>
      <circle cx="58" cy="58" r="${r}" fill="none" style="stroke:var(--danger)" stroke-width="14" stroke-dasharray="${denLen.toFixed(2)} ${(C - denLen).toFixed(2)}" stroke-dashoffset="${(-appLen).toFixed(2)}"/>
    </g>
    <text x="58" y="56" text-anchor="middle" font-size="24" style="fill:var(--ink); font-family:var(--serif)">${pct}%</text>
    <text x="58" y="72" text-anchor="middle" font-size="8" letter-spacing="0.12em" style="fill:var(--ink-faint)">APPROVED</text></svg>`;
}

// Ranked horizontal bars for the most-blocked hosts.
function domainBars(domains) {
  if (!domains || !domains.length) return `<div class="an-empty">No blocked sites yet.</div>`;
  const top = domains.slice(0, 6);
  const max = Math.max(1, ...top.map(([, n]) => n));
  return top.map(([host, n]) => {
    const pct = Math.max(6, Math.round((n / max) * 100));
    return `<div class="dbar"><div class="dbar-track"><div class="dbar-fill" style="width:${pct}%"></div>` +
      `<div class="dbar-txt"><span class="dbar-host">${escapeHtml(host)}</span><span class="dbar-n">${n}</span></div></div></div>`;
  }).join("");
}

document.getElementById("clearAnalytics").addEventListener("click", async () => {
  if (!confirm("Clear all analytics history?")) return;
  await clearAnalytics();
  const s = document.getElementById("clearStatus");
  s.textContent = "Cleared."; setTimeout(() => s.textContent = "", 1500);
  renderAnalytics();
});

// ── Boot ──────────────────────────────────────────────────────────────
const validPanes = ["start", "schedule", "settings", "connectors", "analytics"];
if (location.hash) {
  const name = location.hash.replace("#", "");
  if (validPanes.includes(name)) setPane(name);
  else setPane("start");
} else {
  setPane("start");
}

// Re-render Start pane periodically so calendar sync results show without a reload.
setInterval(() => {
  const startActive = document.getElementById("pane-start").classList.contains("active");
  if (startActive) renderStart();
}, 30_000);
