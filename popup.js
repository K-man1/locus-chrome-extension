// Compact popup. Idle: task input + Start. Active: timer + task line + End.

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

function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

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

let timerInterval = null;
let lastPhase = null; // track transitions to notify once

async function loadPomodoroEnabled() {
  const { pomodoroEnabled } = await chrome.storage.local.get("pomodoroEnabled");
  return !!pomodoroEnabled;
}

async function render() {
  const state = await send({ type: "getState" });
  const pomoEnabled = await loadPomodoroEnabled();

  const idle   = document.getElementById("idle");
  const active = document.getElementById("active");

  if (state.session) {
    idle.style.display   = "none";
    active.style.display = "block";

    const taskText = state.session.taskText || "";
    document.getElementById("taskLine").textContent = taskText
      ? `Task: ${taskText}` : "No specific task.";

    const startedAt  = state.session.startedAt;
    const timerEl    = document.getElementById("timer");
    const phaseEl    = document.getElementById("pomoPhase");

    const tick = () => {
      const elapsed = Date.now() - startedAt;
      if (pomoEnabled) {
        const { phase, remaining, round } = getPomoPhase(elapsed);
        timerEl.textContent = fmtCountdown(remaining);

        const phaseKey = `${phase}-${round}`;
        phaseEl.style.display = "";
        if (phase === "work") {
          phaseEl.textContent = `Work · Round ${round}`;
          phaseEl.className = "pomo-phase";
        } else {
          phaseEl.textContent = "Break";
          phaseEl.className = "pomo-phase break";
        }

        // Notify once when phase transitions
        if (lastPhase !== null && lastPhase !== phaseKey) {
          const msg = phase === "break"
            ? `Round ${round - 1} done — take a 5-minute break!`
            : `Break over — start round ${round}!`;
          chrome.notifications?.create?.(`pomo-${phaseKey}`, {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "Locus · Pomodoro",
            message: msg,
          });
        }
        lastPhase = phaseKey;
      } else {
        timerEl.textContent = fmtElapsed(elapsed);
        phaseEl.style.display = "none";
        lastPhase = null;
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
    document.getElementById("sessionSummary").textContent =
      attempts || approved
        ? `${attempts} block${attempts === 1 ? "" : "s"} · ${approved} approved`
        : "No blocks yet this session.";
  } else {
    idle.style.display   = "block";
    active.style.display = "none";
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    lastPhase = null;
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
  lastPhase = null;
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
