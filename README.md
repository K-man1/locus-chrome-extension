# Locus — Chrome Extension

A focus extension. You define activities (e.g. "Math homework") with a domain whitelist; while a session is active, every other site is blocked. Try to visit a blocked site and an AI gatekeeper asks why you need it. Plausible reasons get a temporary pass; bad ones don't.

Ports the macOS Locus app's core loop to Chrome (Manifest V3).

## Install (developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select this directory.
4. Pin Locus from the puzzle-piece menu so the popup is one click away.
5. Click **Settings** in the popup to manage activities, domains, and the override code.

## How it works

- **Background service worker** watches `chrome.webNavigation` and redirects blocked URLs to an internal `blocked.html` page.
- The blocked page asks the AI gatekeeper if the bare site is obviously relevant (auto-allow). If it isn't, the user types a reason and the AI decides.
- Approvals grant a temporary allow stored in `chrome.storage.local` (default: 10 minutes).
- The override code is a fallback escape hatch — set it to something tedious so future-you thinks twice.

## Features

- **Per-session task.** When starting a session, type one line about what you're working on. Passed into every AI prompt as additional context. Editable mid-session from the popup.
- **Smart re-blocking.** While a temp-allow is active, the background polls each tab's title every ~15s and asks the AI whether you're drifting. If you are, the temp-allow is revoked and you're sent back to the blocked page with the AI's drift reason.
- **Tightened denial UX.** When the AI denies a request, the textarea is replaced by a denial card showing the reason. Refreshing the same tab keeps the denial in place; closing the tab or navigating to a different domain clears it.
- **Analytics.** Local-only event log. The popup's Analytics tab shows focus minutes today/week, sessions, streak, block attempts, AI approvals/denials, drift revocations, top blocked domains, and a 14-day bar chart.
- **Google Calendar import.** Connect your calendar, map event titles (substring) to activities, and Locus auto-starts the matching session at the event's start time. No Notion.
- **Settings parity** with the macOS app: temp-allow duration, harshness (Lenient / Standard / Strict), sound on block, theme (light/dark/system), and an Advanced section to override the three AI prompts (`evaluate_reason`, `evaluate_site_relevance`, `evaluate_title`).

## AI proxy

All AI calls go to `https://locus-proxy.locus-proxy.workers.dev/`. The Cloudflare Worker holds the upstream API key as a server secret and rate-limits per `device_id` (a UUID generated on first run).

## Google Calendar setup

The worker already handles `/oauth/google` for the macOS app. The extension uses `chrome.identity.launchWebAuthFlow` with a redirect target on `chromiumapp.org`, which requires a small additional branch in the worker — see `cloudflare_worker_patch.js`. Until that branch is deployed, set `GOOGLE_CLIENT_ID_FOR_WORKER` in `lib/calendar.js` to the same public client ID the worker is configured with so the auth URL builds; the worker patch is what actually returns the tokens to the extension.

## Files

- `manifest.json` — MV3 manifest
- `background.js` — service worker (navigation, drift sweep, calendar alarms, analytics, denial locks)
- `popup.html / popup.js` — Session + Analytics tabs
- `options.html / options.js` — settings, calendar, prompts
- `blocked.html / blocked.js` — gatekeeper page with denial-lock UX
- `lib/storage.js` — schema + helpers
- `lib/ai.js` — worker client + prompt templates
- `lib/analytics.js` — event log + summary
- `lib/calendar.js` — Google OAuth + event fetch + mapping
- `lib/theme.js` — theme bootstrap
- `cloudflare_worker_patch.js` — note-only patch for the OAuth flow

## Permissions

`storage`, `tabs`, `webNavigation`, `alarms`, `identity`, `scripting`, plus `<all_urls>` host permission.

## Not implemented (and why)

- **Smart App Blocking** — extensions can't kill native apps; macOS-only.
- **Notion connector** — intentionally skipped.
- **Safari/Firefox** — out of scope.

## Limitations

- Doesn't intercept service-worker-controlled SPA route changes that don't fire `webNavigation`.
- No syncing across devices — `chrome.storage.local` only.
- No tracking, no telemetry. All analytics are local.
