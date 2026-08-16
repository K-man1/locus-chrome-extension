// Centralized storage helpers. All extension state lives in chrome.storage.local.
//
// Schema (top-level keys):
//   deviceId:        string
//   alwaysAllowed:   string[]                 // never-blocked domains
//   overrideCode:    string
//   tempAllowMins:   number
//   session:         { taskText, startedAt, source } | null
//   schedules:       [{ id, taskText, days:[0-6], time:"HH:MM", enabled, lastFired }]
//   tempAllow:       { [domain]: { exp: number, reason: string } }
//   denialLocks:     { [tabId]: { host, reason, since } }
//   theme:           "system" | "light" | "dark"
//   harshness:       "Lenient" | "Standard" | "Strict"
//   playSoundOnBlock:boolean
//   pomodoroEnabled: boolean
//   driftCheckEnabled: boolean
//   driftCheckSeconds: number
//   prompts:         { reason, site, title }
//   analytics:       events log (capped)
//   calendar:        { feeds: [{name, url}], upcoming, lastSyncedAt, lastErrors }
//
// Migration from v0.3 (which had `activities` and calendar `mappings`): on
// first load, drop those keys and rewrite any `{activity}` placeholder in
// stored prompt overrides to `{task}`.

const DEFAULTS = {
  alwaysAllowed: ["docs.google.com", "schoology.com", "khanacademy.org"],
  overrideCode: "",
  tempAllowMins: 10,
  session: null,
  schedules: [],
  tempAllow: {},
  denialLocks: {},
  theme: "system",
  harshness: "Standard",
  playSoundOnBlock: false,
  pomodoroEnabled: false,
  pomodoroWorkMin: 25, // custom minutes; presets 15/25/45/60 offered in UI
  pomodoroBreakMin: 5, // custom break length in minutes
  quickFocusButton: true, // floating quick-start button injected on web pages
  quickTasks: ["Work", "HW", "Research"], // seed tasks used before any real history exists
  recentTasks: [], // most-recently-started tasks (case-insensitive, newest first)
  hiddenSites: [], // hostnames where the user chose to hide the floating pill
  driftCheckEnabled: true,
  driftCheckSeconds: 15,
  // Scheduled hard-lock: during the window the extension force-runs a Pomodoro
  // session on one of `tasks` and refuses to pause/end/untimer it.
  lockdown: {
    enabled: false,
    startHour: 8, startMin: 0,
    endHour: 17, endMin: 0,
    days: [1, 2, 3, 4, 5], // Mon–Fri (JS getDay numbering)
    tasks: [
      "Programming — back to basics website",
      "Precalc studying",
      "Work"
    ],
    lastTask: "",
    // Settings that apply only while the lock is live (see resolveSettings in
    // lib/lockdown.js). `null` means "inherit the global value".
    overrides: {
      pomodoroEnabled: true,
      pomodoroWorkMin: 25,
      pomodoroBreakMin: 5,
      harshness: "Strict",
      alwaysAllowed: null // null = use the normal allowlist
    }
  },
  // Live lock latch: { until, startedAt, task } while a lock is in force, else
  // null. Keyed on this — not on lockdown.enabled — so disabling the config
  // mid-window can't spring you early. Cleared only when `until` passes.
  lockCommit: null,
  prompts: { reason: "", site: "", title: "" },
  analytics: { events: [] },
  calendar: {
    feeds: [],
    upcoming: [],
    lastSyncedAt: 0,
    lastErrors: []
  }
};

export async function getState() {
  const stored = await chrome.storage.local.get(null);
  const out = { ...DEFAULTS, ...stored };
  out.alwaysAllowed = stored.alwaysAllowed || DEFAULTS.alwaysAllowed;
  out.hiddenSites = stored.hiddenSites || [];
  out.recentTasks = stored.recentTasks || [];
  out.schedules = stored.schedules || [];
  out.tempAllow = stored.tempAllow || {};
  out.denialLocks = stored.denialLocks || {};
  out.prompts = { ...DEFAULTS.prompts, ...(stored.prompts || {}) };
  out.lockdown = { ...DEFAULTS.lockdown, ...(stored.lockdown || {}) };
  // Overrides need their own merge — a config saved before they existed has no
  // `overrides` key, and a partial one must still fill in the rest.
  out.lockdown.overrides = {
    ...DEFAULTS.lockdown.overrides,
    ...(stored.lockdown?.overrides || {})
  };
  out.lockCommit = stored.lockCommit || null;
  out.calendar = { ...DEFAULTS.calendar, ...(stored.calendar || {}) };
  // Drop legacy mappings if they survived migration somehow.
  if ("mappings" in out.calendar) delete out.calendar.mappings;
  out.analytics = { events: (stored.analytics?.events) || [] };
  // Legacy session shapes are normalized once by migrateLegacy() at install/startup.
  return out;
}

export async function setState(patch) {
  await chrome.storage.local.set(patch);
}

export async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) return deviceId;
  const fresh = (crypto.randomUUID && crypto.randomUUID()) ||
    "ext-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await chrome.storage.local.set({ deviceId: fresh });
  return fresh;
}

// One-shot migration: discard `activities`, calendar `mappings`, and rewrite
// `{activity}` placeholders in stored prompts to `{task}`. Idempotent.
export async function migrateLegacy() {
  const stored = await chrome.storage.local.get(null);
  const patch = {};
  let dirty = false;

  if ("activities" in stored) {
    await chrome.storage.local.remove("activities");
    dirty = true;
  }
  if (stored.calendar && stored.calendar.mappings) {
    const cal = { ...stored.calendar };
    delete cal.mappings;
    patch.calendar = cal;
    dirty = true;
  }
  if (stored.prompts) {
    const p = { ...stored.prompts };
    let changed = false;
    for (const k of ["reason", "site", "title"]) {
      if (typeof p[k] === "string" && p[k].includes("{activity}")) {
        p[k] = p[k].replace(/\{activity\}/g, "{task}");
        changed = true;
      }
    }
    if (changed) { patch.prompts = p; dirty = true; }
  }
  // Lockdowns predating per-lockdown overrides: seed them from the settings
  // that were actually in force back then, rather than letting the new defaults
  // (Strict) quietly make an existing user's locks harsher than they were.
  // Old behavior: the timer was forced on at the global lengths, and harshness
  // and the allowlist were simply the globals.
  if (stored.lockdown && !stored.lockdown.overrides) {
    patch.lockdown = {
      ...stored.lockdown,
      overrides: {
        pomodoroEnabled: true,
        pomodoroWorkMin: stored.pomodoroWorkMin ?? 25,
        pomodoroBreakMin: stored.pomodoroBreakMin ?? 5,
        harshness: stored.harshness ?? "Standard",
        alwaysAllowed: null
      }
    };
    dirty = true;
  }

  if (stored.session && !stored.session.taskText) {
    const t = stored.session.task || stored.session.activity || "";
    if (t) {
      patch.session = {
        taskText: t,
        startedAt: stored.session.startedAt || Date.now(),
        source: stored.session.source || "manual"
      };
      dirty = true;
    } else {
      patch.session = null;
      dirty = true;
    }
  }
  if (dirty) await chrome.storage.local.set(patch);
}

export async function ensureDefaults() {
  await migrateLegacy();
  const stored = await chrome.storage.local.get(null);
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (stored[k] === undefined) patch[k] = v;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  await getDeviceId();
}

// Domain helpers — tolerant of subdomains.
export function hostnameMatches(host, allowlist) {
  if (!host) return false;
  host = host.toLowerCase().replace(/^www\./, "");
  for (const entry of allowlist) {
    const e = (entry || "").toLowerCase().trim().replace(/^www\./, "");
    if (!e) continue;
    if (host === e || host.endsWith("." + e)) return true;
  }
  return false;
}

// Sign-in / OAuth / SSO detection. These pages are pure plumbing to reach a real
// tool, so they're never blocked during a session — getting locked out of a login
// mid-flow (e.g. an OAuth redirect chain) would break access entirely, and a
// login screen is never itself the distraction. Three signals, any one matches:
//   1. A known identity-provider host (suffix match).
//   2. An auth-y subdomain label: accounts./login./auth./sso./id. etc.
//   3. An auth-looking URL path: /oauth, /sso, /signin, /login, /authorize …
const AUTH_HOST_SUFFIXES = [
  "accounts.google.com", "accounts.youtube.com",
  "login.microsoftonline.com", "login.live.com", "login.microsoft.com", "login.windows.net",
  "appleid.apple.com",
  "workos.com",            // auth.workos.com + any *.workos.com auth host
  "auth0.com", "okta.com", "onelogin.com", "duosecurity.com", "pingidentity.com",
  "id.atlassian.com", "signin.aws.amazon.com", "login.salesforce.com",
  "login.yahoo.com", "accounts.spotify.com",
];
const AUTH_SUBDOMAIN_LABELS = new Set([
  "accounts", "account", "login", "signin", "auth", "sso", "idp", "oauth", "openid"
]);
// Matches an auth segment anywhere in the path (e.g. /v3/signin/…, /o/oauth2/auth).
const AUTH_PATH_RE = /(^|\/)(oauth2?|sso|signin|sign-in|login|log-in|logout|authorize|authentication|openid|saml|connect\/authorize)(\/|$)/i;

export function isAuthUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  for (const s of AUTH_HOST_SUFFIXES) {
    if (host === s || host.endsWith("." + s)) return true;
  }
  if (AUTH_SUBDOMAIN_LABELS.has(host.split(".")[0])) return true;
  if (AUTH_PATH_RE.test(u.pathname)) return true;
  return false;
}

export function activeTempAllow(tempAllow, host) {
  const now = Date.now();
  for (const [d, rec] of Object.entries(tempAllow || {})) {
    const exp = (typeof rec === "number") ? rec : rec?.exp;
    if (!exp || exp <= now) continue;
    if (host === d || host.endsWith("." + d)) {
      return {
        domain: d,
        exp,
        reason: (rec && rec.reason) || "",
        source: (rec && rec.source) || "auto",
        grantedAt: (rec && rec.grantedAt) || 0
      };
    }
  }
  return null;
}
