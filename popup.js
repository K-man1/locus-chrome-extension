import { computeSummary } from "./lib/analytics.js";

function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, res));
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function fmtMinsHuman(secs) {
  if (!secs) return "0m";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

let timerInterval = null;
let activeTab = "session";

function setTab(name) {
  activeTab = name;
  document.getElementById("tabSession").classList.toggle("active", name === "session");
  document.getElementById("tabAnalytics").classList.toggle("active", name === "analytics");
  document.getElementById("sessionPane").style.display = name === "session" ? "block" : "none";
  document.getElementById("analyticsPane").style.display = name === "analytics" ? "block" : "none";
  if (name === "analytics") renderAnalytics();
}

async function renderSession() {
  const state = await send({ type: "getState" });
  const idle = document.getElementById("idle");
  const active = document.getElementById("active");

  if (state.session) {
    idle.style.display = "none";
    active.style.display = "block";
    document.getElementById("activeName").textContent = state.session.activity;
    document.getElementById("taskLine").textContent = state.session.task
      ? `Task: ${state.session.task}` : "No specific task.";
    document.getElementById("taskEdit").value = state.session.task || "";

    const startedAt = state.session.startedAt;
    const tick = () => {
      document.getElementById("timer").textContent = fmtElapsed(Date.now() - startedAt);
    };
    tick();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(tick, 1000);

    const list = document.getElementById("allowedList");
    list.innerHTML = "";
    const activity = state.activities[state.session.activity];
    const perm = (activity?.allowDomains || []).map((d) => ({ d, kind: "permanent" }));
    const always = (state.alwaysAllowed || []).map((d) => ({ d, kind: "always" }));
    const now = Date.now();
    const temp = Object.entries(state.tempAllow || {})
      .map(([d, rec]) => {
        const exp = (typeof rec === "number") ? rec : rec?.exp;
        return { d, kind: "temp", exp };
      })
      .filter((x) => x.exp > now);

    const all = [...perm, ...always, ...temp];
    if (all.length === 0) {
      list.innerHTML = `<div class="muted tiny">No domains allowed for this session.</div>`;
    } else {
      for (const item of all) {
        const row = document.createElement("div");
        row.className = "row between";
        row.style.padding = "4px 0";
        const left = document.createElement("div");
        left.textContent = item.d;
        const right = document.createElement("span");
        right.className = "tiny muted";
        if (item.kind === "permanent") right.textContent = "session";
        else if (item.kind === "always") right.textContent = "always";
        else right.textContent = `temp · ${Math.max(0, Math.round((item.exp - now) / 60000))}m`;
        row.appendChild(left); row.appendChild(right);
        list.appendChild(row);
      }
    }
  } else {
    idle.style.display = "block";
    active.style.display = "none";
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

    const sel = document.getElementById("activitySelect");
    sel.innerHTML = "";
    const names = Object.keys(state.activities || {});
    if (names.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "(no activities — open Settings)";
      opt.disabled = true;
      sel.appendChild(opt);
      document.getElementById("startBtn").disabled = true;
    } else {
      for (const n of names) {
        const opt = document.createElement("option");
        opt.value = n; opt.textContent = n;
        sel.appendChild(opt);
      }
      document.getElementById("startBtn").disabled = false;
    }
  }
}

async function renderAnalytics() {
  const s = await computeSummary();
  document.getElementById("focusToday").textContent = fmtMinsHuman(s.focusToday);
  document.getElementById("focusWeek").textContent = fmtMinsHuman(s.focusWeek);
  document.getElementById("sessionsToday").textContent = String(s.sessionsToday);
  document.getElementById("streak").textContent = `${s.streakDays}d`;
  document.getElementById("blockAttempts").textContent = String(s.blockAttempts);
  document.getElementById("blockApproved").textContent = String(s.blockApproved);
  document.getElementById("blockDenied").textContent = String(s.blockDenied);
  document.getElementById("driftRevoked").textContent = String(s.driftRevocations);

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

document.getElementById("tabSession").addEventListener("click", () => setTab("session"));
document.getElementById("tabAnalytics").addEventListener("click", () => setTab("analytics"));

document.getElementById("startBtn").addEventListener("click", async () => {
  const sel = document.getElementById("activitySelect");
  if (!sel.value) return;
  const task = document.getElementById("taskInput").value.trim();
  await send({ type: "startSession", activity: sel.value, task });
  await renderSession();
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  await send({ type: "stopSession" });
  await renderSession();
});

document.getElementById("saveTask").addEventListener("click", async () => {
  const v = document.getElementById("taskEdit").value;
  await send({ type: "updateTask", task: v });
  await renderSession();
});

document.getElementById("opt").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

renderSession();
