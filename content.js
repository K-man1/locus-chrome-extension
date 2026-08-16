// Locus — floating quick-focus widget injected on web pages.
//  • While a session runs: a pill shows the live timer (Pomodoro work/break, or
//    elapsed). Hover reveals the task and an X to hide Locus on this site.
//  • While idle: a button that reveals your two most-recent tasks plus a text
//    box to start any task. Hover X hides Locus on this site.
//  • Per-site hiding and the global on/off toggle are honored via storage.
(() => {
  if (window.top !== window) return;            // top frame only
  if (!document.documentElement) return;
  const HOST_ID = "locus-quickfocus-host";
  if (document.getElementById(HOST_ID)) return; // guard against double-inject

  const DEFAULT_TASKS = ["Work", "HW", "Research"];

  let host, shadow, wrap;
  let mode = null;              // "idle" | "session"
  let taskSig = "";
  let collapseTimer = null, tickTimer = null;
  let cur = {};                 // last state snapshot

  // ── timing (mirrors lib/pomodoro.js; content scripts can't import modules) ──
  function sessionElapsed(s, now = Date.now()) {
    if (!s || !s.startedAt) return 0;
    const anchor = s.pausedAt || now;
    return Math.max(0, anchor - s.startedAt - (s.pausedMs || 0));
  }
  function pomoPhase(elapsedMs, workMin, breakMin) {
    const workMs = (workMin > 0 ? workMin : 25) * 60 * 1000;
    const breakMs = (breakMin > 0 ? breakMin : 5) * 60 * 1000;
    const cycleMs = workMs + breakMs;
    const pos = elapsedMs % cycleMs;
    return pos < workMs
      ? { phase: "work", remaining: workMs - pos }
      : { phase: "break", remaining: cycleMs - pos };
  }

  // Pomodoro settings in force right now (mirrors resolveSettings in
  // lib/lockdown.js): a running lockdown carries its own timer config.
  function pomoSettings(s) {
    const live = !!(s.lockCommit && s.lockCommit.until > Date.now());
    const ov = (live && s.lockdown && s.lockdown.overrides) || {};
    const pick = (k) => (ov[k] !== undefined && ov[k] !== null ? ov[k] : s[k]);
    return {
      enabled: !!pick("pomodoroEnabled"),
      workMin: pick("pomodoroWorkMin"),
      breakMin: pick("pomodoroBreakMin")
    };
  }

  // ── this-site helpers ─────────────────────────────────────────────────────
  function currentDomain() {
    return (location.hostname || "").toLowerCase().replace(/^www\./, "");
  }
  // Does the user's hidden-sites list cover this page? Suffix match so hiding
  // "youtube.com" also hides m.youtube.com etc.
  function siteHidden(hidden) {
    const domain = currentDomain();
    return (hidden || []).some((d) => {
      const e = (d || "").toLowerCase().trim().replace(/^www\./, "");
      return e && (domain === e || domain.endsWith("." + e));
    });
  }

  // Two most-recent tasks, seeded from configured quick tasks / defaults when
  // history is short, deduped case-insensitively so casing variants don't repeat.
  function pillTasks(state) {
    const seed = (state.recentTasks && state.recentTasks.length ? state.recentTasks : [])
      .concat(state.quickTasks && state.quickTasks.length ? state.quickTasks : DEFAULT_TASKS);
    const seen = new Set();
    const out = [];
    for (const t of seed) {
      const key = (t || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(t.trim());
      if (out.length === 2) break;
    }
    return out;
  }
  const two = (n) => String(n).padStart(2, "0");
  function fmtCountdown(ms) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${two(s % 60)}`; }
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
  }

  const CSS = `
    :host {
      all: initial;
      --lc-accent: #FFC93C; --lc-accent-strong: #F2B72A; --lc-on-accent: #2a2006;
      --lc-break: #3f9a6a;
      --lc-card: #ffffff; --lc-ink: #1c1a14; --lc-ink-soft: #6b6558;
      --lc-border: #e7e0d0; --lc-shadow: 0 8px 30px rgba(30,24,10,.18);
      position: fixed; left: 20px; bottom: 20px; z-index: 2147483000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --lc-break: #6fce9a;
        --lc-card: #211e18; --lc-ink: #f2ecdd; --lc-ink-soft: #a9a08c;
        --lc-border: #37322b; --lc-shadow: 0 10px 34px rgba(0,0,0,.5);
      }
    }
    .wrap { position: relative; }
    button { font: inherit; }
    [hidden] { display: none !important; }

    /* Collapsed trigger (idle) */
    .fab {
      width: 46px; height: 46px; border-radius: 50%;
      background: var(--lc-accent); border: none; cursor: pointer; padding: 0;
      display: flex; align-items: center; justify-content: center;
      box-shadow: var(--lc-shadow); opacity: .74;
      transition: opacity .15s ease, transform .15s ease;
    }
    .fab:hover { opacity: 1; transform: translateY(-1px); }
    .fab svg { width: 17px; height: 17px; margin-left: 2px; fill: var(--lc-on-accent); }

    /* Live timer pill (session) — always visible */
    .pill {
      display: inline-flex; align-items: center; gap: 9px;
      background: var(--lc-card); border: 1px solid var(--lc-border);
      border-radius: 999px; box-shadow: var(--lc-shadow);
      padding: 8px 15px 8px 12px; cursor: default; user-select: none;
    }
    .pdot { width: 9px; height: 9px; border-radius: 50%; background: var(--lc-accent); flex: none; }
    .pill.break .pdot { background: var(--lc-break); }
    .pill.paused .pdot { background: var(--lc-ink-soft); }
    .pphase { font-size: 10.5px; text-transform: uppercase; letter-spacing: .09em; color: var(--lc-ink-soft); }
    .pill.break .pphase { color: var(--lc-break); }
    .ptime { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--lc-ink); }

    /* Inline hide-X: collapsed to zero width, expands horizontally on hover. The
       negative margin cancels the flex gap so the collapsed pill has no dead
       space; hovering restores the gap and grows the button in. */
    .px {
      width: 0; opacity: 0; overflow: hidden; margin-left: -9px;
      border: none; background: transparent; color: var(--lc-ink-soft);
      font-size: 13px; line-height: 1; cursor: pointer; padding: 0; flex: none;
      pointer-events: none;
      transition: width .15s ease, opacity .15s ease, margin-left .15s ease;
    }
    .pill:hover .px { width: 15px; opacity: 1; margin-left: 0; pointer-events: auto; }
    .px:hover { color: var(--lc-ink); }

    /* Hide-confirmation popover for the session pill (idle uses .card instead) */
    .spop {
      position: absolute; left: 0; bottom: calc(100% + 8px); width: 200px;
      background: var(--lc-card); border: 1px solid var(--lc-border);
      border-radius: 13px; box-shadow: var(--lc-shadow); padding: 11px;
    }

    /* Pop-over card (task menu or session controls) — above the trigger */
    .card {
      position: absolute; left: 0; bottom: calc(100% + 8px); min-width: 172px;
      background: var(--lc-card); border: 1px solid var(--lc-border);
      border-radius: 15px; box-shadow: var(--lc-shadow); padding: 11px;
      opacity: 0; transform: translateY(6px) scale(.98); transform-origin: bottom left;
      pointer-events: none; transition: opacity .15s ease, transform .15s ease;
    }
    .wrap.open .card { opacity: 1; transform: none; pointer-events: auto; }
    .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; gap: 10px; }
    .head .title { font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--lc-ink-soft); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x { width: 26px; height: 26px; border: none; background: transparent; color: var(--lc-ink-soft); font-size: 14px; line-height: 1; cursor: pointer; border-radius: 7px; flex: none; }
    .x:hover { background: color-mix(in srgb, var(--lc-ink) 8%, transparent); color: var(--lc-ink); }

    .tasks { display: flex; flex-direction: column; gap: 6px; }
    .task {
      display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      border: 1px solid var(--lc-border); background: transparent; color: var(--lc-ink);
      border-radius: 10px; padding: 9px 11px; font-size: 13px; font-weight: 500; cursor: pointer;
      transition: background .12s ease, border-color .12s ease;
    }
    .task:hover { background: color-mix(in srgb, var(--lc-accent) 16%, transparent); border-color: var(--lc-accent); }
    .task::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--lc-accent); flex: none; }

    /* Free-form task entry in the idle menu */
    .taskinput {
      width: 100%; margin-top: 6px; border: 1px solid var(--lc-border);
      background: var(--lc-card); color: var(--lc-ink);
      border-radius: 10px; padding: 9px 11px; font-size: 13px; font-family: inherit;
      outline: none; transition: border-color .12s ease;
    }
    .taskinput:focus { border-color: var(--lc-accent); }
    .taskinput::placeholder { color: var(--lc-ink-soft); }

    /* "Hide on this site?" confirmation, shown over the card body */
    .confirm { margin-top: 4px; }
    .confirm-msg { font-size: 12.5px; color: var(--lc-ink); margin-bottom: 9px; line-height: 1.4; }
    .confirm-msg b { word-break: break-all; }
    .confirm-actions { display: flex; gap: 6px; }
    .cbtn {
      flex: 1; border: 1px solid var(--lc-border); background: transparent; color: var(--lc-ink);
      border-radius: 9px; padding: 8px 10px; font-size: 12.5px; font-weight: 500; cursor: pointer;
    }
    .cbtn:hover { background: color-mix(in srgb, var(--lc-ink) 7%, transparent); }
    .cbtn.hide { color: #c0492f; }
    .cbtn.hide:hover { background: color-mix(in srgb, #c0492f 12%, transparent); border-color: #c0492f; }
  `;

  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = CSS;
      shadow.appendChild(style);
    }
    wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.addEventListener("mouseenter", () => setOpen(true));
    wrap.addEventListener("mouseleave", () => setOpen(false));
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
  }

  function setOpen(open) {
    if (!wrap) return;
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    if (open) { wrap.classList.add("open"); return; }
    collapseTimer = setTimeout(() => wrap.classList.remove("open"), 220);
  }

  function teardown() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (host) { host.remove(); host = shadow = wrap = null; }
    mode = null; taskSig = "";
  }

  // Set once the extension is reloaded/updated out from under an already-open
  // tab. chrome.* calls throw synchronously in that state (not via a rejected
  // promise or callback), so a plain .catch() on them never fires — every call
  // site that can run more than once needs its own try/catch. Once detected,
  // stop touching chrome.* entirely and tear the widget down; the page would
  // need a reload to get a live extension context back.
  let contextDead = false;
  function handleContextInvalidated() {
    if (contextDead) return;
    contextDead = true;
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch {}
    teardown();
  }

  function send(msg) {
    if (contextDead) return;
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch {
      handleContextInvalidated();
    }
  }

  // ── idle: recent tasks + free-form entry ────────────────────────────────
  function buildIdle() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    ensureHost();
    const tasks = pillTasks(cur);
    wrap.innerHTML = `
      <button class="fab" type="button" aria-label="Start a focus session" title="Start a focus session">
        <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="6,4 20,12 6,20"></polygon></svg>
      </button>
      <div class="card" role="menu" aria-label="Start a focus session">
        <div class="head"><span class="title">Start focus</span><button class="x" type="button" aria-label="Hide Locus on this site" title="Hide Locus on this site">&#10005;</button></div>
        <div class="body">
          <div class="tasks"></div>
          <input class="taskinput" type="text" placeholder="Or type a task…" aria-label="Type a task to focus on">
        </div>
      </div>`;
    const list = wrap.querySelector(".tasks");
    tasks.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "task";
      b.textContent = t;
      b.addEventListener("click", () => send({ type: "startSession", taskText: t, source: "quick" }));
      list.appendChild(b);
    });
    const input = wrap.querySelector(".taskinput");
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const t = input.value.trim();
      if (t) send({ type: "startSession", taskText: t, source: "quick" });
    });
    wireHideX();
  }

  // The X on the card asks to permanently hide the pill on this domain, via a
  // small in-widget confirmation (no jarring native dialog). Shared by both the
  // idle and session cards.
  function wireHideX() {
    const card = wrap.querySelector(".card");
    const body = card.querySelector(".body");
    const x = card.querySelector(".x");
    if (!x || !body) return;
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      if (card.querySelector(".confirm")) return; // already asking
      body.style.display = "none";
      const c = document.createElement("div");
      c.className = "confirm";
      c.innerHTML =
        `<div class="confirm-msg">Never show Locus on <b></b>?</div>` +
        `<div class="confirm-actions"><button class="cbtn cancel" type="button">Cancel</button><button class="cbtn hide" type="button">Hide</button></div>`;
      c.querySelector("b").textContent = currentDomain();
      card.appendChild(c);
      c.querySelector(".cancel").addEventListener("click", (ev) => {
        ev.stopPropagation();
        c.remove();
        body.style.display = "";
      });
      c.querySelector(".hide").addEventListener("click", (ev) => {
        ev.stopPropagation();
        send({ type: "hideSite", domain: currentDomain() });
        teardown();
      });
    });
  }

  // ── session: live timer pill ─────────────────────────────────────────────
  // Hovering shows the task and the hide-X only — no pause/end here (that lives
  // in the popup and dashboard), so the pill can't become an easy escape hatch.
  function buildSession() {
    ensureHost();
    wrap.innerHTML = `
      <div class="pill">
        <span class="pdot"></span><span class="pphase"></span><span class="ptime"></span>
        <button class="px" type="button" aria-label="Hide Locus on this site" title="Hide Locus on this site">&#10005;</button>
      </div>`;
    wireSessionHideX();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
    tick();
  }

  // Clicking the inline X on the pill opens a small confirmation popover above it
  // (mirrors the idle card's confirm, but standalone so the pill stays compact).
  function wireSessionHideX() {
    const px = wrap.querySelector(".px");
    if (!px) return;
    px.addEventListener("click", (e) => {
      e.stopPropagation();
      if (wrap.querySelector(".spop")) return; // already asking
      const pop = document.createElement("div");
      pop.className = "spop";
      pop.innerHTML =
        `<div class="confirm-msg">Never show Locus on <b></b>?</div>` +
        `<div class="confirm-actions"><button class="cbtn cancel" type="button">Cancel</button><button class="cbtn hide" type="button">Hide</button></div>`;
      pop.querySelector("b").textContent = currentDomain();
      wrap.appendChild(pop);
      pop.querySelector(".cancel").addEventListener("click", (ev) => { ev.stopPropagation(); pop.remove(); });
      pop.querySelector(".hide").addEventListener("click", (ev) => {
        ev.stopPropagation();
        send({ type: "hideSite", domain: currentDomain() });
        teardown();
      });
    });
  }

  function tick() {
    const s = cur.session;
    if (!s || !wrap) return;
    const pill = wrap.querySelector(".pill");
    const phaseEl = wrap.querySelector(".pphase");
    const timeEl = wrap.querySelector(".ptime");
    if (!pill) return;

    const paused = !!s.pausedAt;
    const elapsed = sessionElapsed(s);
    let cls = "pill", label, time;
    const pomo = pomoSettings(cur);
    if (pomo.enabled) {
      const { phase, remaining } = pomoPhase(elapsed, pomo.workMin, pomo.breakMin);
      time = fmtCountdown(remaining);
      label = phase === "work" ? "Work" : "Break";
      if (phase === "break") cls += " break";
    } else {
      time = fmtElapsed(elapsed);
      label = "Focus";
    }
    if (paused) { cls += " paused"; label = "Paused"; }
    pill.className = cls;
    phaseEl.textContent = label;
    timeEl.textContent = time;

    // Task name (and lock status when active) live in the pill's native tooltip
    // now that the pill has no hover card of its own.
    const locked = !!(s.locked && s.lockedUntil && s.lockedUntil > Date.now());
    let tip = s.taskText || "Focus session";
    if (locked) {
      tip += ` · Locked in until ${new Date(s.lockedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    }
    pill.title = tip;
  }

  // ── state routing ───────────────────────────────────────────────────────
  function apply(state) {
    cur = state;
    if (state.quickFocusButton === false || siteHidden(state.hiddenSites)) { teardown(); return; }
    if (state.session) {
      if (mode !== "session") { mode = "session"; buildSession(); }
      else tick();
    } else {
      const sig = pillTasks(state).join("|");
      if (mode !== "idle" || sig !== taskSig) { mode = "idle"; taskSig = sig; buildIdle(); }
    }
  }

  const KEYS = ["quickFocusButton", "quickTasks", "recentTasks", "hiddenSites", "session",
    "pomodoroEnabled", "pomodoroWorkMin", "pomodoroBreakMin", "lockdown", "lockCommit"];

  function refresh() {
    if (contextDead) return;
    try {
      chrome.storage.local.get(KEYS).then(apply).catch(() => {});
    } catch {
      handleContextInvalidated();
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (!KEYS.some((k) => k in changes)) return;
    refresh();
  }

  refresh();
  chrome.storage.onChanged.addListener(onStorageChanged);
})();
