// Centralized storage helpers. All extension state lives in chrome.storage.local.
//
// Schema (top-level keys):
//   deviceId:        string
//   activities:      { [name]: { allowDomains: string[] } }
//   alwaysAllowed:   string[]
//   overrideCode:    string
//   tempAllowMins:   number
//   session:         { activity, startedAt, task } | null
//   tempAllow:       { [domain]: { exp: number, reason: string } }
//   denialLocks:     { [tabId]: { host, reason, since } }   // tightened denial UX
//   theme:           "system" | "light" | "dark"
//   harshness:       "Lenient" | "Standard" | "Strict"
//   playSoundOnBlock:boolean
//   driftCheckEnabled: boolean
//   driftCheckSeconds: number          // how often the content script pings
//   prompts:         { reason, site, title }   // user overrides; empty → use defaults
//   analytics:       events log (capped) + computed cache
//   calendar:        { googleToken, googleRefreshToken, googleExpiresAt, mappings: [{ keyword, activity, autoStart }], lastSyncedAt }

const DEFAULTS = {
  activities: {
    "Deep Work": { allowDomains: ["docs.google.com", "github.com"] },
    "Math homework": { allowDomains: ["desmos.com", "khanacademy.org", "wolframalpha.com"] }
  },
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
    googleToken: "",
    googleRefreshToken: "",
    googleExpiresAt: 0,
    googleEmail: "",
    mappings: [],
    upcoming: [],
    lastSyncedAt: 0
  }
};

export async function getState() {
  const stored = await chrome.storage.local.get(null);
  const out = { ...DEFAULTS, ...stored };
  out.activities = stored.activities || DEFAULTS.activities;
  out.alwaysAllowed = stored.alwaysAllowed || DEFAULTS.alwaysAllowed;
  out.tempAllow = stored.tempAllow || {};
  out.denialLocks = stored.denialLocks || {};
  out.prompts = { ...DEFAULTS.prompts, ...(stored.prompts || {}) };
  out.calendar = { ...DEFAULTS.calendar, ...(stored.calendar || {}) };
  out.analytics = { events: (stored.analytics?.events) || [] };
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

export async function ensureDefaults() {
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

// ── Temp-allow read helper ────────────────────────────────────────────────
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
