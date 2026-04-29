import { PROMPT_DEFAULTS } from "./lib/ai.js";
import {
  startGoogleOAuth, disconnectGoogle, fetchUpcomingEvents, isOAuthConfigured
} from "./lib/calendar.js";
import { clearAnalytics } from "./lib/analytics.js";

function send(msg) { return new Promise((res) => chrome.runtime.sendMessage(msg, res)); }
async function getAll() { return await send({ type: "getState" }); }
async function save(patch) { await chrome.storage.local.set(patch); }

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

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

async function render() {
  const state = await getAll();

  // Activities
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

  // Always allowed
  const aaTags = document.getElementById("alwaysAllowedTags");
  aaTags.innerHTML = "";
  for (const d of (state.alwaysAllowed || [])) {
    aaTags.appendChild(tag(d, async () => {
      await save({ alwaysAllowed: state.alwaysAllowed.filter((x) => x !== d) });
      render();
    }));
  }

  // General
  document.getElementById("theme").value = state.theme || "system";
  document.getElementById("harshness").value = state.harshness || "Standard";
  document.getElementById("tempAllowMins").value = String(state.tempAllowMins ?? 10);
  document.getElementById("driftSeconds").value = String(state.driftCheckSeconds ?? 15);
  document.getElementById("playSoundOnBlock").checked = !!state.playSoundOnBlock;
  document.getElementById("driftCheckEnabled").checked = !!state.driftCheckEnabled;

  // Override code
  document.getElementById("overrideCode").value = state.overrideCode || "";

  // Prompts
  document.getElementById("promptReason").value = state.prompts?.reason || "";
  document.getElementById("promptSite").value = state.prompts?.site || "";
  document.getElementById("promptTitle").value = state.prompts?.title || "";

  // Calendar
  const cal = state.calendar || {};
  const calStatus = document.getElementById("calStatus");
  const calEmail = document.getElementById("calEmail");
  if (cal.googleToken) {
    calStatus.textContent = "Connected.";
    calEmail.textContent = cal.googleEmail ? `Account: ${cal.googleEmail}` : "";
    if (cal.lastSyncedAt) {
      calEmail.textContent += `${cal.googleEmail ? " · " : ""}Last sync ${new Date(cal.lastSyncedAt).toLocaleString()}`;
    }
  } else {
    calStatus.textContent = "Not connected.";
    calEmail.textContent = "";
  }
  const warn = document.getElementById("calConfigWarn");
  if (!isOAuthConfigured()) {
    warn.hidden = false;
    warn.textContent = "Google OAuth client ID not set — see lib/calendar.js (GOOGLE_CLIENT_ID_FOR_WORKER) and cloudflare_worker_patch.js.";
  } else { warn.hidden = true; }

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

  // Upcoming list
  const up = document.getElementById("calUpcoming");
  if (!cal.upcoming?.length) {
    up.textContent = "No events synced yet.";
  } else {
    up.innerHTML = "";
    for (const e of cal.upcoming.slice(0, 12)) {
      const row = document.createElement("div"); row.className = "row between";
      row.style.padding = "3px 0";
      const left = document.createElement("div"); left.textContent = e.title;
      const right = document.createElement("span"); right.className = "tiny muted";
      try { right.textContent = new Date(e.start).toLocaleString(); } catch { right.textContent = e.start; }
      row.appendChild(left); row.appendChild(right);
      up.appendChild(row);
    }
  }
}

// ── Event handlers ────────────────────────────────────────────────────────
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
  // Apply theme live.
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

// Calendar
document.getElementById("calConnect").addEventListener("click", async () => {
  try {
    const r = await startGoogleOAuth();
    alert(`Connected as ${r.email || "Google account"}. Click Sync now to fetch events.`);
    render();
  } catch (e) {
    alert(`OAuth failed: ${e.message}`);
  }
});

document.getElementById("calSync").addEventListener("click", async () => {
  const r = await send({ type: "calendar:sync" });
  if (!r?.ok) alert(`Sync failed: ${r?.error || "unknown"}`);
  render();
});

document.getElementById("calDisconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect Google Calendar?")) return;
  await disconnectGoogle();
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
});

render();
