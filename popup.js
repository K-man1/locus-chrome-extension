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

let timerInterval = null;

async function render() {
  const state = await send({ type: "getState" });
  const idle = document.getElementById("idle");
  const active = document.getElementById("active");

  if (state.session) {
    idle.style.display = "none";
    active.style.display = "block";
    document.getElementById("activeName").textContent = state.session.activity;

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
      .filter(([, exp]) => exp > now)
      .map(([d, exp]) => ({ d, kind: "temp", exp }));

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

document.getElementById("startBtn").addEventListener("click", async () => {
  const sel = document.getElementById("activitySelect");
  if (!sel.value) return;
  await send({ type: "startSession", activity: sel.value });
  await render();
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  await send({ type: "stopSession" });
  await render();
});

document.getElementById("opt").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();
