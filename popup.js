// Compact popup: idle → pick activity + task + start; active → timer +
// editable task + end. Anything else is in the full dashboard tab.

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

    // Tiny block-since-start summary.
    const events = (state.analytics?.events) || [];
    let attempts = 0, approved = 0;
    for (const ev of events) {
      if (!ev.ts || ev.ts < startedAt) continue;
      if (ev.type === "block_attempt") attempts++;
      else if (ev.type === "block_approved") approved++;
    }
    document.getElementById("sessionSummary").textContent =
      attempts || approved
        ? `${attempts} block${attempts === 1 ? "" : "s"} · ${approved} approved`
        : "No blocks yet this session.";
  } else {
    idle.style.display = "block";
    active.style.display = "none";
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

    const sel = document.getElementById("activitySelect");
    sel.innerHTML = "";
    const names = Object.keys(state.activities || {});
    if (names.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "(no activities — open Dashboard)";
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
  const task = document.getElementById("taskInput").value.trim();
  await send({ type: "startSession", activity: sel.value, task });
  await render();
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  await send({ type: "stopSession" });
  await render();
});

document.getElementById("saveTask").addEventListener("click", async () => {
  const v = document.getElementById("taskEdit").value;
  await send({ type: "updateTask", task: v });
  await render();
});

function openDashboard(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}
document.getElementById("openDash").addEventListener("click", openDashboard);
document.getElementById("openDash2").addEventListener("click", openDashboard);

render();
