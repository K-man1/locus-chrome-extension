// Service worker. Watches navigation, blocks non-whitelisted hosts during a
// focus session, and brokers AI eval requests from the blocked page.

import { getState, setState, ensureDefaults, hostnameMatches } from "./lib/storage.js";
import { evaluateReason, evaluateSiteRelevance } from "./lib/ai.js";

const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");

chrome.runtime.onInstalled.addListener(() => { ensureDefaults(); });
chrome.runtime.onStartup.addListener(() => { ensureDefaults(); });

// Periodic temp-allow GC.
chrome.alarms.create("locus-gc", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "locus-gc") return;
  const { tempAllow } = await getState();
  const now = Date.now();
  let changed = false;
  const next = {};
  for (const [d, exp] of Object.entries(tempAllow || {})) {
    if (exp > now) next[d] = exp; else changed = true;
  }
  if (changed) await setState({ tempAllow: next });
});

async function shouldBlock(url) {
  if (!url || !/^https?:/i.test(url)) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!host) return null;

  const { session, activities, alwaysAllowed, tempAllow } = await getState();
  if (!session || !session.activity) return null;

  const activity = activities[session.activity];
  if (!activity) return null;

  if (hostnameMatches(host, alwaysAllowed)) return null;
  if (hostnameMatches(host, activity.allowDomains || [])) return null;

  // Active temp-allow?
  const now = Date.now();
  for (const [d, exp] of Object.entries(tempAllow || {})) {
    if (exp <= now) continue;
    if (host === d || host.endsWith("." + d)) return null;
  }

  return { host, session: session.activity };
}

async function maybeRedirect(tabId, url) {
  const blocked = await shouldBlock(url);
  if (!blocked) return;
  const target = `${BLOCKED_PAGE}?url=${encodeURIComponent(url)}&host=${encodeURIComponent(blocked.host)}&session=${encodeURIComponent(blocked.session)}`;
  try {
    await chrome.tabs.update(tabId, { url: target });
  } catch (e) {
    // Tab may have closed; ignore.
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  maybeRedirect(details.tabId, details.url);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  // Catches client-side redirects and history.pushState navs to a fresh host.
  maybeRedirect(details.tabId, details.url);
});

// Message API for popup, options, blocked page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "getState":
          sendResponse(await getState()); break;

        case "startSession": {
          const { activities } = await getState();
          if (!activities[msg.activity]) {
            sendResponse({ ok: false, error: "Unknown activity" }); break;
          }
          await setState({ session: { activity: msg.activity, startedAt: Date.now() } });
          sendResponse({ ok: true });
          break;
        }

        case "stopSession":
          await setState({ session: null, tempAllow: {} });
          sendResponse({ ok: true });
          break;

        case "evaluateRelevance": {
          const { session } = await getState();
          if (!session) { sendResponse({ approved: false, reason: "no session" }); break; }
          const r = await evaluateSiteRelevance({
            domain: msg.host, session: session.activity, title: msg.title || ""
          });
          if (r.approved) await grantTempAllow(msg.host);
          sendResponse(r);
          break;
        }

        case "evaluateReason": {
          const { session } = await getState();
          if (!session) { sendResponse({ approved: false, reason: "no session" }); break; }
          const r = await evaluateReason({
            domain: msg.host, session: session.activity, reason: msg.reason
          });
          if (r.approved) await grantTempAllow(msg.host);
          sendResponse(r);
          break;
        }

        case "tryOverride": {
          const { overrideCode } = await getState();
          const ok = (msg.code || "").trim() === (overrideCode || "").trim() && !!overrideCode;
          if (ok) await grantTempAllow(msg.host);
          sendResponse({ ok });
          break;
        }

        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async
});

async function grantTempAllow(host) {
  const { tempAllow, tempAllowMins } = await getState();
  const next = { ...(tempAllow || {}) };
  next[host] = Date.now() + (Number(tempAllowMins) || 10) * 60_000;
  await setState({ tempAllow: next });
}
