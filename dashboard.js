// Full-tab dashboard. Sidebar: Start / Settings / Connectors / Analytics.

import { PROMPT_DEFAULTS } from "./lib/ai.js";
import { computeSummary, clearAnalytics } from "./lib/analytics.js";

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

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
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
}
document.querySelectorAll(".side-nav button").forEach((b) => {
  b.addEventListener("click", () => setPane(b.dataset.pane));
});

// ── Start pane ─────────────────────────────────────────────────────────
const POMO_WORK_MS  = 25 * 60 * 1000;
const POMO_BREAK_MS =  5 * 60 * 1000;
const POMO_CYCLE_MS = POMO_WORK_MS + POMO_BREAK_MS;

function getPomoPhase(elapsedMs) {
  const cyclePos = elapsedMs % POMO_CYCLE_MS;
  const round = Math.floor(elapsedMs / POMO_CYCLE_MS) + 1;
  if (cyclePos < POMO_WORK_MS) {
    return { phase: "work", remaining: POMO_WORK_MS - cyclePos, round };
  }
  return { phase: "break", remaining: POMO_CYCLE_MS - cyclePos, round };
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

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

    const { pomodoroEnabled } = await chrome.storage.local.get("pomodoroEnabled");
    const startedAt = state.session.startedAt;
    const timerEl = document.getElementById("activeTimer");
    const phaseEl = document.getElementById("activePomoPhase");

    const tick = () => {
      const elapsed = Date.now() - startedAt;
      if (pomodoroEnabled) {
        const { phase, remaining, round } = getPomoPhase(elapsed);
        timerEl.textContent = fmtCountdown(remaining);
        phaseEl.style.display = "";
        phaseEl.textContent = phase === "work" ? `Work · Round ${round}` : "Break";
        phaseEl.style.color = phase === "break" ? "var(--accent)" : "var(--ink-soft)";
      } else {
        timerEl.textContent = fmtElapsed(elapsed);
        phaseEl.style.display = "none";
      }
    };
    tick();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(tick, 1000);

    const events = (state.analytics?.events) || [];
    let attempts = 0, approved = 0;
    for (const ev of events) {
      if (!ev.ts || ev.ts < startedAt) continue;
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
document.getElementById("activeEndBtn").addEventListener("click", async () => {
  await send({ type: "stopSession" });
  renderStart();
});
// ── Settings pane ──────────────────────────────────────────────────────
async function renderSettings() {
  const state = await getAll();
  document.getElementById("alwaysAllowedText").value = (state.alwaysAllowed || []).join("\n");
  document.getElementById("theme").value = state.theme || "system";
  document.getElementById("harshness").value = state.harshness || "Standard";
  document.getElementById("tempAllowMins").value = String(state.tempAllowMins ?? 10);
  document.getElementById("driftSeconds").value = String(state.driftCheckSeconds ?? 15);
  document.getElementById("playSoundOnBlock").checked = !!state.playSoundOnBlock;
  document.getElementById("driftCheckEnabled").checked = !!state.driftCheckEnabled;
  const { pomodoroEnabled } = await chrome.storage.local.get("pomodoroEnabled");
  document.getElementById("pomodoroEnabled").checked = !!pomodoroEnabled;
  document.getElementById("overrideCode").value = state.overrideCode || "";
  document.getElementById("promptReason").value = state.prompts?.reason || "";
  document.getElementById("promptSite").value = state.prompts?.site || "";
  document.getElementById("promptTitle").value = state.prompts?.title || "";
}

document.getElementById("theme").addEventListener("change", (event) => {
  const selected = event.target.value;
  if (selected === "system" || selected === "light" || selected === "dark") {
    document.documentElement.setAttribute("data-theme", selected);
  }
});

document.getElementById("saveAlwaysAllowed").addEventListener("click", async () => {
  const raw = document.getElementById("alwaysAllowedText").value;
  const list = raw.split(/[\n,]+/)
    .map((s) => s.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase())
    .filter(Boolean);
  // de-dupe, preserve order
  const seen = new Set(); const out = [];
  for (const d of list) { if (!seen.has(d)) { seen.add(d); out.push(d); } }
  await save({ alwaysAllowed: out });
  const s = document.getElementById("alwaysAllowedStatus");
  s.textContent = `Saved ${out.length} domain${out.length === 1 ? "" : "s"}.`;
  setTimeout(() => s.textContent = "", 1800);
});

document.getElementById("saveOverride").addEventListener("click", async () => {
  const v = document.getElementById("overrideCode").value;
  await save({ overrideCode: v });
  const s = document.getElementById("overrideStatus");
  s.textContent = "Saved."; setTimeout(() => s.textContent = "", 1500);
});

document.getElementById("saveGeneral").addEventListener("click", async () => {
  const tempMins = parseInt(document.getElementById("tempAllowMins").value, 10);
  const drift = parseInt(document.getElementById("driftSeconds").value, 10);
  if (!Number.isFinite(tempMins) || tempMins <= 0) { alert("Temp-allow minutes must be positive."); return; }
  if (!Number.isFinite(drift) || drift < 10) { alert("Drift seconds must be ≥ 10."); return; }
  await save({
    theme: document.getElementById("theme").value,
    harshness: document.getElementById("harshness").value,
    tempAllowMins: tempMins,
    driftCheckSeconds: drift,
    playSoundOnBlock: document.getElementById("playSoundOnBlock").checked,
    driftCheckEnabled: document.getElementById("driftCheckEnabled").checked,
    pomodoroEnabled: document.getElementById("pomodoroEnabled").checked
  });
  document.documentElement.setAttribute("data-theme", document.getElementById("theme").value);
  const s = document.getElementById("generalStatus");
  s.textContent = "Saved."; setTimeout(() => s.textContent = "", 1500);
});

document.getElementById("savePrompts").addEventListener("click", async () => {
  await save({
    prompts: {
      reason: document.getElementById("promptReason").value,
      site: document.getElementById("promptSite").value,
      title: document.getElementById("promptTitle").value
    }
  });
  const s = document.getElementById("promptStatus");
  s.textContent = "Saved."; setTimeout(() => s.textContent = "", 1500);
});

document.getElementById("resetPrompts").addEventListener("click", () => {
  document.getElementById("promptReason").value = PROMPT_DEFAULTS.reason;
  document.getElementById("promptSite").value = PROMPT_DEFAULTS.site;
  document.getElementById("promptTitle").value = PROMPT_DEFAULTS.title;
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

  const bars = document.getElementById("dailyBars");
  bars.innerHTML = "";
  const entries = Object.entries(s.dailySeries).sort((a, b) => a[0].localeCompare(b[0]));
  const max = Math.max(1, ...entries.map(([, v]) => v));
  for (const [day, secs] of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const lab = document.createElement("div");
    lab.className = "bar-label";
    lab.innerHTML = `<span>${escapeHtml(day.slice(5))}</span><span>${fmtMinsHuman(secs)}</span>`;
    const bar = document.createElement("div"); bar.className = "bar";
    const fill = document.createElement("div"); fill.className = "bar-fill";
    fill.style.width = `${Math.round((secs / max) * 100)}%`;
    bar.appendChild(fill);
    row.appendChild(lab); row.appendChild(bar);
    bars.appendChild(row);
  }

  const td = document.getElementById("topDomains");
  if (!s.topBlockedDomains.length) {
    td.textContent = "No blocks yet.";
  } else {
    td.innerHTML = "";
    for (const [host, n] of s.topBlockedDomains) {
      const row = document.createElement("div");
      row.className = "stat";
      row.innerHTML = `<span>${escapeHtml(host)}</span><span class="v">${n}</span>`;
      td.appendChild(row);
    }
  }
}

document.getElementById("clearAnalytics").addEventListener("click", async () => {
  if (!confirm("Clear all analytics history?")) return;
  await clearAnalytics();
  const s = document.getElementById("clearStatus");
  s.textContent = "Cleared."; setTimeout(() => s.textContent = "", 1500);
  renderAnalytics();
});

// ── Boot ──────────────────────────────────────────────────────────────
const validPanes = ["start", "settings", "connectors", "analytics"];
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
