// Full-tab dashboard: activities, calendar (iCal), analytics, settings, about.

import { PROMPT_DEFAULTS } from "./lib/ai.js";
import { computeSummary, clearAnalytics } from "./lib/analytics.js";

function send(msg) { return new Promise((res) => chrome.runtime.sendMessage(msg, res)); }
async function getAll() { return await send({ type: "getState" }); }
async function save(patch) { await chrome.storage.local.set(patch); }

function tag(text, onRemove) {
  const span = document.createElement("span");
  span.className = "tag";
  span.textContent = text;
  const x = document.createElement("span");
  x.className = "x"; x.textContent = "×"; x.title = "Remove";
  x.addEventListener("click", onRemove);
  span.appendChild(x);
  return span;
}

function fmtMinsHuman(secs) {
  if (!secs) return "0m";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

// ── Tabs ───────────────────────────────────────────────────────────────
function setPane(name) {
  document.querySelectorAll(".nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.pane === name);
  });
  document.querySelectorAll(".pane").forEach((p) => {
    p.classList.toggle("active", p.id === `pane-${name}`);
  });
  if (name === "analytics") renderAnalytics();
}
document.querySelectorAll(".nav button").forEach((b) => {
  b.addEventListener("click", () => setPane(b.dataset.pane));
});

// ── Render ─────────────────────────────────────────────────────────────
async function render() {
  const state = await getAll();

  // Activities ----------------------------------------------------------
  const acts = document.getElementById("activities");
  acts.innerHTML = "";
  const names = Object.keys(state.activities || {});
  if (names.length === 0) acts.innerHTML = `<div class="muted tiny">No activities yet — add one below.</div>`;
  for (const name of names) {
    const a = state.activities[name];
    const card = document.createElement("div"); card.className = "card";
    const head = document.createElement("div"); head.className = "row between";
    const title = document.createElement("input");
    title.type = "text"; title.value = name;
    title.style.flex = "1"; title.style.fontWeight = "600"; title.style.fontSize = "15px";
    title.addEventListener("change", async () => {
      const newName = title.value.trim();
      if (!newName || newName === name) { title.value = name; return; }
      if (state.activities[newName]) { alert("That name is taken."); title.value = name; return; }
      const next = { ...state.activities };
      next[newName] = next[name];
      delete next[name];
      await save({ activities: next });
      if (state.session?.activity === name) {
        await save({ session: { ...state.session, activity: newName } });
      }
      render();
    });
    const del = document.createElement("button");
    del.className = "danger small"; del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${name}"?`)) return;
      const next = { ...state.activities };
      delete next[name];
      const patch = { activities: next };
      if (state.session?.activity === name) patch.session = null;
      await save(patch);
      render();
    });
    head.appendChild(title); head.appendChild(del); card.appendChild(head);

    const sub = document.createElement("div");
    sub.className = "muted tiny"; sub.textContent = "Allowed domains";
    sub.style.marginTop = "10px"; card.appendChild(sub);

    const tags = document.createElement("div"); tags.className = "domains";
    for (const d of (a.allowDomains || [])) {
      tags.appendChild(tag(d, async () => {
        const next = { ...state.activities };
        next[name] = { ...a, allowDomains: a.allowDomains.filter((x) => x !== d) };
        await save({ activities: next }); render();
      }));
    }
    card.appendChild(tags);

    const add = document.createElement("div"); add.className = "add-domain";
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = "khanacademy.org";
    const btn = document.createElement("button"); btn.textContent = "Add";
    const doAdd = async () => {
      const v = input.value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
      if (!v) return;
      if ((a.allowDomains || []).includes(v)) { input.value = ""; return; }
      const next = { ...state.activities };
      next[name] = { ...a, allowDomains: [...(a.allowDomains || []), v] };
      await save({ activities: next }); render();
    };
    btn.addEventListener("click", doAdd);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    add.appendChild(input); add.appendChild(btn); card.appendChild(add);

    acts.appendChild(card);
  }

  // Always allowed -----------------------------------------------------
  const aaTags = document.getElementById("alwaysAllowedTags");
  aaTags.innerHTML = "";
  for (const d of (state.alwaysAllowed || [])) {
    aaTags.appendChild(tag(d, async () => {
      await save({ alwaysAllowed: state.alwaysAllowed.filter((x) => x !== d) });
      render();
    }));
  }

  // Settings -----------------------------------------------------------
  document.getElementById("theme").value = state.theme || "system";
  document.getElementById("harshness").value = state.harshness || "Standard";
  document.getElementById("tempAllowMins").value = String(state.tempAllowMins ?? 10);
  document.getElementById("driftSeconds").value = String(state.driftCheckSeconds ?? 15);
  document.getElementById("playSoundOnBlock").checked = !!state.playSoundOnBlock;
  document.getElementById("driftCheckEnabled").checked = !!state.driftCheckEnabled;
  document.getElementById("overrideCode").value = state.overrideCode || "";
  document.getElementById("promptReason").value = state.prompts?.reason || "";
  document.getElementById("promptSite").value = state.prompts?.site || "";
  document.getElementById("promptTitle").value = state.prompts?.title || "";

  // Calendar — feeds ---------------------------------------------------
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
      const next = [...feeds];
      next[idx] = { name: nm.value.trim(), url: url.value.trim() };
      await save({ calendar: { ...cal, feeds: next } });
    };
    nm.addEventListener("change", persist);
    url.addEventListener("change", persist);
    del.addEventListener("click", async () => {
      const next = feeds.filter((_, i) => i !== idx);
      await save({ calendar: { ...cal, feeds: next } });
      render();
    });
    row.appendChild(nm); row.appendChild(url); row.appendChild(del);
    feedsDiv.appendChild(row);
  });

  // Feed errors
  const errBox = document.getElementById("feedErrors");
  errBox.innerHTML = "";
  for (const err of (cal.lastErrors || [])) {
    const div = document.createElement("div");
    div.className = "feed-error";
    div.textContent = `${err.name || err.url}: ${err.error}. (Some providers block fetch from extensions due to CORS — try a different export URL.)`;
    errBox.appendChild(div);
  }

  // Cal status line
  const statusEl = document.getElementById("calStatus");
  if (cal.lastSyncedAt) {
    statusEl.textContent = `Last sync ${new Date(cal.lastSyncedAt).toLocaleString()} · ${(cal.upcoming || []).length} events`;
  } else {
    statusEl.textContent = feeds.length ? "Not synced yet — click Sync now." : "Add a feed to start.";
  }

  // Mapping activity dropdown
  const mapSel = document.getElementById("newMapActivity");
  mapSel.innerHTML = "";
  for (const n of names) {
    const opt = document.createElement("option"); opt.value = n; opt.textContent = n;
    mapSel.appendChild(opt);
  }

  // Mappings list
  const mapList = document.getElementById("calMappings");
  mapList.innerHTML = "";
  const mappings = cal.mappings || [];
  if (!mappings.length) mapList.innerHTML = `<div class="muted tiny">No mappings yet.</div>`;
  mappings.forEach((m, idx) => {
    const row = document.createElement("div"); row.className = "map-row";
    const kw = document.createElement("input"); kw.type = "text"; kw.value = m.keyword || "";
    const sel = document.createElement("select");
    for (const n of names) {
      const o = document.createElement("option"); o.value = n; o.textContent = n;
      if (n === m.activity) o.selected = true;
      sel.appendChild(o);
    }
    const lab = document.createElement("label"); lab.className = "tiny";
    const auto = document.createElement("input"); auto.type = "checkbox"; auto.checked = !!m.autoStart;
    lab.appendChild(auto); lab.appendChild(document.createTextNode(" auto-start"));
    const del = document.createElement("button"); del.className = "danger small"; del.textContent = "×";
    const persist = async () => {
      const next = [...mappings];
      next[idx] = { keyword: kw.value, activity: sel.value, autoStart: auto.checked };
      await save({ calendar: { ...cal, mappings: next } });
      await send({ type: "calendar:reschedule" });
      render();
    };
    kw.addEventListener("change", persist);
    sel.addEventListener("change", persist);
    auto.addEventListener("change", persist);
    del.addEventListener("click", async () => {
      const next = mappings.filter((_, i) => i !== idx);
      await save({ calendar: { ...cal, mappings: next } });
      await send({ type: "calendar:reschedule" });
      render();
    });
    row.appendChild(kw); row.appendChild(sel); row.appendChild(lab); row.appendChild(del);
    mapList.appendChild(row);
  });

  // Upcoming list — show only auto-start matches first, then everything else
  const up = document.getElementById("calUpcoming");
  if (!cal.upcoming?.length) {
    up.textContent = "No events synced yet.";
  } else {
    up.innerHTML = "";
    const lcMappings = (cal.mappings || []);
    const items = [...cal.upcoming].slice(0, 30);
    for (const e of items) {
      const row = document.createElement("div"); row.className = "upcoming-row";
      const left = document.createElement("div");
      left.textContent = e.title;
      const matched = lcMappings.find((m) => m.keyword && (e.title || "").toLowerCase().includes((m.keyword || "").toLowerCase()));
      if (matched) {
        const b = document.createElement("span"); b.className = "badge";
        b.textContent = matched.autoStart ? `auto → ${matched.activity}` : `mapped → ${matched.activity}`;
        b.style.marginLeft = "8px";
        left.appendChild(b);
      }
      const right = document.createElement("span"); right.className = "tiny muted";
      try { right.textContent = new Date(e.start).toLocaleString(); } catch { right.textContent = e.start; }
      row.appendChild(left); row.appendChild(right);
      up.appendChild(row);
    }
  }
}

// ── Analytics rendering ────────────────────────────────────────────────
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
    lab.innerHTML = `<span>${day.slice(5)}</span><span>${fmtMinsHuman(secs)}</span>`;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.round((secs / max) * 100)}%`;
    bar.appendChild(fill);
    row.appendChild(lab); row.appendChild(bar);
    bars.appendChild(row);
  }

  // By-activity — naive accumulation from event log.
  const state = await getAll();
  const events = state.analytics?.events || [];
  const cutoff = Date.now() - 14 * 86400_000;
  const byAct = {};
  for (const ev of events) {
    if (ev.type !== "session_end" || (ev.ts || 0) < cutoff) continue;
    const a = ev.activity || "(unknown)";
    byAct[a] = (byAct[a] || 0) + (ev.duration_ms || 0) / 1000;
  }
  const ba = document.getElementById("byActivity");
  const sorted = Object.entries(byAct).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    ba.textContent = "No completed sessions yet.";
  } else {
    ba.innerHTML = "";
    const maxA = Math.max(...sorted.map(([, v]) => v));
    for (const [name, secs] of sorted) {
      const row = document.createElement("div"); row.className = "bar-row";
      const lab = document.createElement("div"); lab.className = "bar-label";
      lab.innerHTML = `<span>${name}</span><span>${fmtMinsHuman(secs)}</span>`;
      const bar = document.createElement("div"); bar.className = "bar";
      const fill = document.createElement("div"); fill.className = "bar-fill";
      fill.style.width = `${Math.round((secs / maxA) * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(lab); row.appendChild(bar);
      ba.appendChild(row);
    }
  }

  const td = document.getElementById("topDomains");
  if (!s.topBlockedDomains.length) {
    td.textContent = "No blocks yet.";
  } else {
    td.innerHTML = "";
    for (const [host, n] of s.topBlockedDomains) {
      const row = document.createElement("div");
      row.className = "stat";
      row.innerHTML = `<span>${host}</span><span class="v">${n}</span>`;
      td.appendChild(row);
    }
  }
}

// ── Event handlers ─────────────────────────────────────────────────────
document.getElementById("addActivity").addEventListener("click", async () => {
  const inp = document.getElementById("newActivityName");
  const v = inp.value.trim();
  if (!v) return;
  const state = await getAll();
  if (state.activities[v]) { alert("Already exists."); return; }
  const next = { ...state.activities, [v]: { allowDomains: [] } };
  await save({ activities: next });
  inp.value = ""; render();
});

document.getElementById("addAlwaysAllowed").addEventListener("click", async () => {
  const inp = document.getElementById("newAlwaysAllowed");
  const v = inp.value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!v) return;
  const state = await getAll();
  if ((state.alwaysAllowed || []).includes(v)) { inp.value = ""; return; }
  await save({ alwaysAllowed: [...(state.alwaysAllowed || []), v] });
  inp.value = ""; render();
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
    driftCheckEnabled: document.getElementById("driftCheckEnabled").checked
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

document.getElementById("resetPrompts").addEventListener("click", async () => {
  document.getElementById("promptReason").value = PROMPT_DEFAULTS.reason;
  document.getElementById("promptSite").value = PROMPT_DEFAULTS.site;
  document.getElementById("promptTitle").value = PROMPT_DEFAULTS.title;
});

// Calendar — feeds
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
  render();
});

document.getElementById("calSync").addEventListener("click", async () => {
  const statusEl = document.getElementById("calStatus");
  statusEl.textContent = "Syncing…";
  const r = await send({ type: "calendar:sync" });
  if (!r?.ok) {
    statusEl.textContent = `Sync failed: ${r?.error || "unknown"}`;
  }
  render();
});

document.getElementById("addMapping").addEventListener("click", async () => {
  const kw = document.getElementById("newMapKeyword").value.trim();
  const act = document.getElementById("newMapActivity").value;
  const auto = document.getElementById("newMapAutoStart").checked;
  if (!kw || !act) return;
  const state = await getAll();
  const cal = state.calendar || {};
  const mappings = [...(cal.mappings || []), { keyword: kw, activity: act, autoStart: auto }];
  await save({ calendar: { ...cal, mappings } });
  document.getElementById("newMapKeyword").value = "";
  await send({ type: "calendar:reschedule" });
  render();
});

document.getElementById("clearAnalytics").addEventListener("click", async () => {
  if (!confirm("Clear all analytics history?")) return;
  await clearAnalytics();
  const s = document.getElementById("clearStatus");
  s.textContent = "Cleared."; setTimeout(() => s.textContent = "", 1500);
  renderAnalytics();
});

// If URL hash specifies a tab, open it.
if (location.hash) {
  const name = location.hash.replace("#", "");
  if (["activities", "calendar", "analytics", "settings", "about"].includes(name)) setPane(name);
}

render();
