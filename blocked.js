import { escapeHtml } from "./lib/format.js";

const params = new URLSearchParams(location.search);
const blockedUrl = params.get("url") || "";
const host = params.get("host") || "";
const taskParam = params.get("task") || "";
const pageTitle = params.get("title") || "";
const driftReason = params.get("drift") || "";
const askReason = params.get("askReason") || "";
const startedDenied = params.get("denied") === "1";

document.getElementById("urlBox").textContent = blockedUrl || "(unknown)";
document.getElementById("taskName").textContent = taskParam || "your task";

if (driftReason) {
  const box = document.getElementById("driftBox");
  box.hidden = false;
  box.className = "verdict drift";
  box.innerHTML = `<strong>Drift detected.</strong> ${escapeHtml(driftReason)}`;
} else if (askReason) {
  const box = document.getElementById("askReasonBox");
  box.hidden = false;
  box.innerHTML = `<strong>AI's read:</strong> ${escapeHtml(askReason)}`;
}

function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, res));
}

function setStatus(el, html) { el.innerHTML = html; }

function showLocked(reason) {
  document.getElementById("askBox").hidden = true;
  document.getElementById("lockedBox").hidden = false;
  document.getElementById("lockedReason").textContent = reason || "Not relevant to the current task.";
}

async function proceed() {
  if (!blockedUrl) return;
  location.replace(blockedUrl);
}

(async () => {
  const state = await send({ type: "getState" });
  document.getElementById("taskLine").textContent = "If you really need this page, tell the AI why.";

  if (state?.playSoundOnBlock) playBlockSound();

  if (startedDenied) {
    showLocked("The AI denied a previous request for this site in this tab.");
  }
})();

document.getElementById("submitBtn").addEventListener("click", async () => {
  const reason = document.getElementById("reason").value.trim();
  const status = document.getElementById("status");
  if (!reason) {
    setStatus(status, `<div class="error">Tell the AI why you need this site.</div>`);
    return;
  }
  setStatus(status, `<div class="muted tiny"><span class="spinner"></span>Asking the AI…</div>`);
  const r = await send({ type: "evaluateReason", host, reason, url: blockedUrl, title: pageTitle });
  if (!r) { setStatus(status, `<div class="error">No response from background.</div>`); return; }
  if (r.approved) {
    setStatus(status, `<div class="verdict approved"><strong>Approved.</strong> ${escapeHtml(r.reason)}</div>`);
    setTimeout(proceed, 900);
  } else if (r.transient) {
    setStatus(status, `<div class="error">${escapeHtml(r.reason)}</div>`);
  } else {
    showLocked(r.reason);
  }
});

async function closeThisTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab && tab.id != null) { chrome.tabs.remove(tab.id); return; }
  } catch {}
  try { window.close(); } catch {}
}
document.getElementById("backBtn").addEventListener("click", closeThisTab);
document.getElementById("lockedBack").addEventListener("click", closeThisTab);

// Override requires a deliberate 5-second press-and-hold — no accidental taps,
// and enough friction that future-you has to really mean it.
(() => {
  const HOLD_MS = 5000;
  const btn = document.getElementById("overrideBtn");
  const fill = document.getElementById("holdFill");
  const label = document.getElementById("holdLabel");
  const status = document.getElementById("overrideStatus");
  let rafId = null, startedAt = 0, firing = false;

  function reset() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null; startedAt = 0;
    fill.style.width = "0%";
    btn.classList.remove("holding");
    if (!firing) label.textContent = "Hold to override (5s)";
  }

  function frame(now) {
    const pct = Math.min(100, ((now - startedAt) / HOLD_MS) * 100);
    fill.style.width = pct + "%";
    if (pct >= 100) { rafId = null; complete(); return; }
    rafId = requestAnimationFrame(frame);
  }

  async function complete() {
    firing = true;
    label.textContent = "Checking…";
    const code = document.getElementById("code").value;
    const r = await send({ type: "tryOverride", host, code });
    if (r && r.ok) {
      setStatus(status, `<div class="ok">Override accepted. Continuing…</div>`);
      label.textContent = "Override accepted";
      setTimeout(proceed, 500);
    } else {
      setStatus(status, `<div class="error">Wrong code.</div>`);
      firing = false;
      reset();
    }
  }

  function startHold(e) {
    e.preventDefault();
    if (firing || rafId) return;
    if (!document.getElementById("code").value.trim()) {
      setStatus(status, `<div class="error">Enter your override code first.</div>`);
      return;
    }
    setStatus(status, "");
    btn.classList.add("holding");
    label.textContent = "Keep holding…";
    startedAt = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function cancelHold() {
    if (firing || !rafId) return;
    reset();
  }

  btn.addEventListener("pointerdown", startHold);
  btn.addEventListener("pointerup", cancelHold);
  btn.addEventListener("pointerleave", cancelHold);
  btn.addEventListener("pointercancel", cancelHold);
})();

function playBlockSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 220;
    g.gain.value = 0.0001;
    o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t); o.stop(t + 0.3);
  } catch {}
}
