// Google Calendar OAuth + event fetching for the Chrome extension.
//
// Flow:
//   1. We call chrome.identity.launchWebAuthFlow with a URL that points at the
//      Cloudflare Worker's /oauth/google endpoint (extension flavor) — see
//      cloudflare_worker_patch.js for the small server-side change required.
//      The worker exchanges the code for tokens and redirects back to
//      chrome.identity.getRedirectURL() with the tokens encoded in the URL
//      fragment so the extension can read them.
//
//      If the worker patch hasn't been deployed, the fallback path uses PKCE
//      directly against accounts.google.com — set GOOGLE_CLIENT_ID below.
//
// We persist the access token + refresh token + expiry. Refresh goes through
// the worker's existing POST /oauth/google/refresh endpoint.

import { getState, setState } from "./storage.js";

const WORKER_BASE = "https://locus-proxy.locus-proxy.workers.dev";
const WORKER_OAUTH = `${WORKER_BASE}/oauth/google`;        // GET (worker patch adds ?ext=1 mode)
const WORKER_REFRESH = `${WORKER_BASE}/oauth/google/refresh`; // POST (already deployed)
const SCOPES = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email";

function redirectURL() {
  // e.g. https://<extension-id>.chromiumapp.org/
  return chrome.identity.getRedirectURL("oauth");
}

// Build the Google auth URL pointed at the worker's redirect URI. The worker
// receives ?state=<extension redirect> and bounces back to it after exchange.
function buildAuthURL(state) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("response_type", "code");
  // Worker holds the real client_id/secret. We pass the extension callback
  // URL as state so the worker can bounce tokens back to us.
  u.searchParams.set("client_id", GOOGLE_CLIENT_ID_FOR_WORKER);
  u.searchParams.set("redirect_uri", `${WORKER_BASE}/oauth/google`);
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

// The worker already has GOOGLE_CLIENT_ID as a server secret. We hardcode the
// public client ID here so the auth URL can be built. If unset, the user will
// see a clear error and can fall back to manual setup. This must match the
// client_id whose client_secret is set on the worker.
const GOOGLE_CLIENT_ID_FOR_WORKER = ""; // ← public OAuth client ID (safe to ship)

export function isOAuthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID_FOR_WORKER);
}

export async function startGoogleOAuth() {
  if (!isOAuthConfigured()) {
    throw new Error(
      "Google OAuth client ID not configured. Edit lib/calendar.js and set " +
      "GOOGLE_CLIENT_ID_FOR_WORKER to the public client ID matching your worker secret."
    );
  }
  const ext = redirectURL();
  // We send the extension callback URL as `state`; the patched worker route
  // reads it and redirects there with `#access_token=…&refresh_token=…`.
  const authURL = buildAuthURL(encodeURIComponent(ext));
  const responseURL = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authURL, interactive: true },
      (cb) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(cb);
      }
    );
  });
  if (!responseURL) throw new Error("OAuth cancelled.");
  // Tokens come in the fragment.
  const frag = (responseURL.split("#")[1] || responseURL.split("?")[1] || "");
  const params = new URLSearchParams(frag);
  const access = params.get("access_token");
  const refresh = params.get("refresh_token");
  const expiresIn = parseInt(params.get("expires_in") || "0", 10);
  const err = params.get("error");
  if (err) throw new Error(err);
  if (!access) throw new Error("No access_token returned.");

  const expiresAt = Date.now() + Math.max(60, expiresIn) * 1000;

  // Optional: fetch the email so the UI can show which account is connected.
  let email = "";
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${access}` }
    });
    if (r.ok) {
      const j = await r.json();
      email = j.email || "";
    }
  } catch { /* ignore */ }

  const { calendar } = await getState();
  await setState({
    calendar: {
      ...calendar,
      googleToken: access,
      googleRefreshToken: refresh || calendar.googleRefreshToken || "",
      googleExpiresAt: expiresAt,
      googleEmail: email,
      lastSyncedAt: 0
    }
  });
  return { email };
}

export async function disconnectGoogle() {
  const { calendar } = await getState();
  await setState({
    calendar: {
      ...calendar,
      googleToken: "",
      googleRefreshToken: "",
      googleExpiresAt: 0,
      googleEmail: "",
      upcoming: []
    }
  });
}

async function ensureFreshToken() {
  const { calendar } = await getState();
  if (!calendar.googleToken) throw new Error("Not signed in to Google.");
  if (calendar.googleExpiresAt > Date.now() + 60_000) return calendar.googleToken;
  if (!calendar.googleRefreshToken) {
    // Token expired and we have no refresh token — user must re-auth.
    throw new Error("Google session expired. Please reconnect.");
  }
  const r = await fetch(WORKER_REFRESH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: calendar.googleRefreshToken })
  });
  if (!r.ok) throw new Error(`refresh failed (${r.status})`);
  const j = await r.json();
  const expiresAt = Date.now() + Math.max(60, j.expires_in || 3600) * 1000;
  await setState({
    calendar: { ...calendar, googleToken: j.access_token, googleExpiresAt: expiresAt }
  });
  return j.access_token;
}

export async function fetchUpcomingEvents(daysAhead = 14) {
  const token = await ensureFreshToken();
  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 86400_000);
  const u = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  u.searchParams.set("timeMin", now.toISOString());
  u.searchParams.set("timeMax", end.toISOString());
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", "100");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`calendar fetch failed (${r.status})`);
  const j = await r.json();
  const items = (j.items || []).map((e) => ({
    id: e.id,
    title: e.summary || "(untitled)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || ""
  })).filter((x) => x.start);
  const { calendar } = await getState();
  await setState({ calendar: { ...calendar, upcoming: items, lastSyncedAt: Date.now() } });
  return items;
}

// Match an event title against user-defined keyword → activity mappings.
export function matchMapping(eventTitle, mappings) {
  const t = (eventTitle || "").toLowerCase();
  for (const m of mappings || []) {
    const kw = (m.keyword || "").toLowerCase().trim();
    if (!kw) continue;
    if (t.includes(kw)) return m;
  }
  return null;
}
