const params = new URLSearchParams(location.search);
const blockedUrl = params.get("url") || "";
const host = params.get("host") || "";
const session = params.get("session") || "";
const driftReason = params.get("drift") || "";
const startedDenied = params.get("denied") === "1";

document.getElementById("urlBox").textContent = blockedUrl || "(unknown)";
document.getElementById("sessionName").textContent = session || "your session";
document.getElementById("sessionTag").textContent = session ? `Session · ${session}` : "Focus session";

if (driftReason) {
  const box = document.getElementById("driftBox");
  box.hidden = false;
  box.className = "verdict drift";
  box.innerHTML = `<strong>Drift detected.</strong> ${escapeHtml(driftReason)}`;
}

function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, res));
}

function setStatus(el, html) { el.innerHTML = html; }

function showLocked(reason) {
  document.getElementById("askBox").hidden = true;
  document.getElementById("lockedBox").hidden = false;
  document.getElementById("lockedReason").textContent = reason || "Not relevant to the current session.";
}

async function proceed() {
  if (!blockedUrl) return;
  location.replace(blockedUrl);
}

// Show task & maybe play sound on block, then auto-evaluate site.
(async () => {
  const state = await send({ type: "getState" });
  const taskLine = document.getElementById("taskLine");
  if (state?.session?.task) {
    taskLine.textContent = `Working on: ${state.session.task}.`;
  } else {
    taskLine.textContent = "If you really need this page, tell the AI why.";
  }

  if (state?.playSoundOnBlock) playBlockSound();

  if (startedDenied) {
    // The denial-lock for this tab is already set. Show locked UI immediately.
    showLocked("The AI denied a previous request for this site in this tab.");
    return;
  }

  const status = document.getElementById("status");
  setStatus(status, `<div class="muted tiny"><span class="spinner"></span>Checking with the AI…</div>`);
  const r = await send({ type: "evaluateRelevance", host, title: document.title || "" });
  if (r && r.approved) {
    setStatus(status, `<div class="verdict approved">Auto-allowed: ${escapeHtml(r.reason || "obviously relevant")}. Continuing…</div>`);
    setTimeout(proceed, 700);
  } else {
    setStatus(status, "");
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
  const r = await send({ type: "evaluateReason", host, reason });
  if (!r) { setStatus(status, `<div class="error">No response from background.</div>`); return; }
  if (r.approved) {
    setStatus(status, `<div class="verdict approved"><strong>Approved.</strong> ${escapeHtml(r.reason)}</div>`);
    setTimeout(proceed, 900);
  } else {
    showLocked(r.reason);
  }
});

document.getElementById("backBtn").addEventListener("click", () => {
  if (history.length > 1) history.back(); else location.replace("about:blank");
});
document.getElementById("lockedBack").addEventListener("click", () => {
  if (history.length > 1) history.back(); else location.replace("about:blank");
});

document.getElementById("overrideBtn").addEventListener("click", async () => {
  const code = document.getElementById("code").value;
  const status = document.getElementById("overrideStatus");
  const r = await send({ type: "tryOverride", host, code });
  if (r && r.ok) {
    setStatus(status, `<div class="ok">Override accepted. Continuing…</div>`);
    setTimeout(proceed, 500);
  } else {
    setStatus(status, `<div class="error">Wrong code.</div>`);
  }
});

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// A short synthesized "thunk" via WebAudio — no asset needed, no base64 bloat.
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
