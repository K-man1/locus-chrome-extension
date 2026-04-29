// Centralized storage helpers. All extension state lives in chrome.storage.local.
//
// Schema (top-level keys):
//   deviceId:        string
//   alwaysAllowed:   string[]                 // never-blocked domains
//   overrideCode:    string
//   tempAllowMins:   number
//   session:         { taskText, startedAt, source } | null
//   tempAllow:       { [domain]: { exp: number, reason: string } }
//   denialLocks:     { [tabId]: { host, reason, since } }
//   theme:           "system" | "light" | "dark"
//   harshness:       "Lenient" | "Standard" | "Strict"
//   playSoundOnBlock:boolean
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
  overrideCode: "31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679",
  tempAllowMins: 10,
  session: null,
  tempAllow: {},
  denialLocks: {},
  theme: "system",
  harshness: "Standard",
  playSoundOnBlock: false,
  driftCheckEnabled: true,
  driftCheckSeconds: 15,
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
  out.tempAllow = stored.tempAllow || {};
  out.denialLocks = stored.denialLocks || {};
  out.prompts = { ...DEFAULTS.prompts, ...(stored.prompts || {}) };
  out.calendar = { ...DEFAULTS.calendar, ...(stored.calendar || {}) };
  // Drop legacy mappings if they survived migration somehow.
  if ("mappings" in out.calendar) delete out.calendar.mappings;
  out.analytics = { events: (stored.analytics?.events) || [] };
  // Normalize legacy session shape ({activity, task, ...}) -> {taskText, ...}
  if (out.session && !out.session.taskText) {
    const t = out.session.task || out.session.activity || "";
    out.session = {
      taskText: t,
      startedAt: out.session.startedAt || Date.now(),
      source: out.session.source || "manual"
    };
  }
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

export function rootDomain(host) {
  if (!host) return "";
  host = host.toLowerCase().replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

export function activeTempAllow(tempAllow, host) {
  const now = Date.now();
  for (const [d, rec] of Object.entries(tempAllow || {})) {
    const exp = (typeof rec === "number") ? rec : rec?.exp;
    if (!exp || exp <= now) continue;
    if (host === d || host.endsWith("." + d)) {
      return { domain: d, exp, reason: (rec && rec.reason) || "" };
    }
  }
  return null;
}
