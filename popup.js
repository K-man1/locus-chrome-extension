// Compact popup. Idle: task input + Start. Active: timer + editable task + End.
// Anything else (settings, connectors, analytics, upcoming list) is in the dashboard tab.

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
    const taskText = state.session.taskText || "";
    document.getElementById("taskLine").textContent = taskText
      ? `Task: ${taskText}` : "No specific task.";
    const startedAt = state.session.startedAt;
    const tick = () => {
      document.getElementById("timer").textContent = fmtElapsed(Date.now() - startedAt);
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
    document.getElementById("sessionSummary").textContent =
      attempts || approved
        ? `${attempts} block${attempts === 1 ? "" : "s"} · ${approved} approved`
        : "No blocks yet this session.";
  } else {
    idle.style.display = "block";
    active.style.display = "none";
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    const inp = document.getElementById("taskInput");
    if (inp && document.activeElement !== inp) inp.focus();
  }
}

async function startSession() {
  const taskText = document.getElementById("taskInput").value.trim();
  if (!taskText) {
    document.getElementById("taskInput").focus();
    return;
  }
  await send({ type: "startSession", taskText, source: "manual" });
  await render();
}

document.getElementById("startBtn").addEventListener("click", startSession);
document.getElementById("taskInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startSession();
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  await send({ type: "stopSession" });
  await render();
});

function openDashboard(e) {
  if (e) e.preventDefault();
  chrome.runtime.openOptionsPage();
}
document.getElementById("openDash").addEventListener("click", openDashboard);
const upLink = document.getElementById("openDashUpcoming");
if (upLink) upLink.addEventListener("click", openDashboard);

render();
