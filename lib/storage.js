// Centralized storage helpers. All extension state lives in chrome.storage.local.
//
// Schema:
//   deviceId:        string (uuid, generated on first run, used for worker rate limiting)
//   activities:      { [name]: { allowDomains: string[] } }
//   alwaysAllowed:   string[]  domains never blocked
//   overrideCode:    string    fallback escape hatch
//   tempAllowMins:   number    minutes a temp-allow lasts
//   session:         { activity: string, startedAt: number } | null
//   tempAllow:       { [domain]: number /* expiresAt ms */ }

const DEFAULTS = {
  activities: {
    "Deep Work": { allowDomains: ["docs.google.com", "github.com"] },
    "Math homework": { allowDomains: ["desmos.com", "khanacademy.org", "wolframalpha.com"] }
  },
  alwaysAllowed: ["docs.google.com", "schoology.com", "khanacademy.org"],
  overrideCode: "31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679",
  tempAllowMins: 10,
  session: null,
  tempAllow: {}
};

export async function getState() {
  const stored = await chrome.storage.local.get(null);
  const out = { ...DEFAULTS, ...stored };
  // Make sure nested defaults are not undefined.
  out.activities = stored.activities || DEFAULTS.activities;
  out.alwaysAllowed = stored.alwaysAllowed || DEFAULTS.alwaysAllowed;
  out.tempAllow = stored.tempAllow || {};
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

// Domain helpers — tolerant of subdomains. "docs.google.com" matches when
// allowlist contains "google.com" OR "docs.google.com".
export function hostnameMatches(host, allowlist) {
  if (!host) return false;
  host = host.toLowerCase().replace(/^www\./, "");
  for (const entry of allowlist) {
    const e = entry.toLowerCase().trim().replace(/^www\./, "");
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
  // Naive: take last 2. Good enough for the common case; subdomain-rich
  // sites (foo.github.io) are intentionally treated as their root.
  return parts.slice(-2).join(".");
}
