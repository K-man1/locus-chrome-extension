// Compact popup. Idle: task input + Start. Active: timer + task line + Pause/End.

import { fmtElapsed, fmtCountdown } from "./lib/format.js";
import { getPomoPhase, sessionElapsed, isPaused } from "./lib/pomodoro.js";

function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, res));
}

let timerInterval = null;

async function render() {
  const state = await send({ type: "getState" });
  // `effective` carries the lockdown's overrides while a lock is running, so
  // the popup shows the lock's timer, not the user's normal one.
  const eff = state.effective || state;
  const pomoEnabled = !!eff.pomodoroEnabled;
  const pomoWorkMin = eff.pomodoroWorkMin || 25;
  const pomoBreakMin = eff.pomodoroBreakMin || 5;

  const idle   = document.getElementById("idle");
  const active = document.getElementById("active");

  if (state.session) {
    idle.style.display   = "none";
    active.style.display = "block";

    const taskText = state.session.taskText || "";
    document.getElementById("taskLine").textContent = taskText
      ? `Task: ${taskText}` : "No specific task.";

    const session = state.session;
    renderLock(state, session);
    const paused  = isPaused(session);
    const timerEl = document.getElementById("timer");
    const phaseEl = document.getElementById("pomoPhase");
    document.getElementById("pauseBtn").textContent = paused ? "Resume" : "Pause";

    const tick = () => {
      const elapsed = sessionElapsed(session);
      if (pomoEnabled) {
        const { phase, remaining, round } = getPomoPhase(elapsed, pomoWorkMin, pomoBreakMin);
        timerEl.textContent = fmtCountdown(remaining);
        phaseEl.style.display = "";
        if (paused) {
          phaseEl.textContent = "Paused";
          phaseEl.className = "pomo-phase";
        } else if (phase === "work") {
          phaseEl.textContent = `Work · Round ${round}`;
          phaseEl.className = "pomo-phase";
        } else {
          phaseEl.textContent = "Break";
          phaseEl.className = "pomo-phase break";
        }
      } else {
        timerEl.textContent = fmtElapsed(elapsed);
        phaseEl.className = "pomo-phase";
        phaseEl.style.display = paused ? "" : "none";
        if (paused) phaseEl.textContent = "Paused";
      }
    };

    tick();
    if (timerInterval) clearInterval(timerInterval);
    // No need to tick while frozen; just show the static paused state.
    timerInterval = paused ? null : setInterval(tick, 1000);

    const events = (state.analytics?.events) || [];
    let attempts = 0, approved = 0;
    for (const ev of events) {
      if (!ev.ts || ev.ts < session.startedAt) continue;
      if (ev.type === "block_attempt") attempts++;
      else if (ev.type === "block_approved") approved++;
    }
    document.getElementById("sessionSummary").textContent =
      attempts || approved
        ? `${attempts} block${attempts === 1 ? "" : "s"} · ${approved} approved`
        : "No blocks yet this session.";
  } else {
    idle.style.display   = "block";
    active.style.display = "none";
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    const inp = document.getElementById("taskInput");
    if (inp && document.activeElement !== inp) inp.focus();
  }
}

// When a lockdown is in force, swap the Pause/End controls for a task switcher
// limited to the allowed tasks, and show when the lock lifts.
function renderLock(state, session) {
  const panel = document.getElementById("lockPanel");
  const actions = document.getElementById("activeActions");
  const locked = !!(session.locked && session.lockedUntil && session.lockedUntil > Date.now());

  if (!locked) {
    panel.style.display = "none";
    actions.style.display = "flex";
    return;
  }

  actions.style.display = "none";
  panel.style.display = "block";
  document.getElementById("lockNote").textContent = `Locked until ${fmtClock(session.lockedUntil)}`;

  const tasks = state.lockdown?.tasks || [];
  const listEl = document.getElementById("lockTasks");
  listEl.innerHTML = "";
  for (const t of tasks) {
    const b = document.createElement("button");
    b.textContent = t;
    if (t === session.taskText) {
      b.className = "current";
    } else {
      b.addEventListener("click", async () => {
        await send({ type: "updateTask", taskText: t });
        await render();
      });
    }
    listEl.appendChild(b);
  }
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

document.getElementById("pauseBtn").addEventListener("click", async () => {
  await send({ type: "togglePause" });
  await render();
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
