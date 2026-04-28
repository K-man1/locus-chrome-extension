const params = new URLSearchParams(location.search);
const blockedUrl = params.get("url") || "";
const host = params.get("host") || "";
const session = params.get("session") || "";

document.getElementById("urlBox").textContent = blockedUrl || "(unknown)";
document.getElementById("sessionName").textContent = session || "your session";
document.getElementById("sessionTag").textContent = session ? `Session · ${session}` : "Focus session";

function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, res));
}

function setStatus(el, html) {
  el.innerHTML = html;
}

async function proceed() {
  // Allow has been granted; navigate the tab to the original URL.
  if (!blockedUrl) return;
  location.replace(blockedUrl);
}

// On load, ask the worker if the bare site is obviously relevant — auto-allow
// study-adjacent things without making the user type.
(async () => {
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
    setStatus(status, `<div class="verdict denied"><strong>Denied.</strong> ${escapeHtml(r.reason)}</div>`);
  }
});

document.getElementById("backBtn").addEventListener("click", () => {
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
