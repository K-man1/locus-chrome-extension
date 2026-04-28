# Locus — Chrome Extension

A focus extension. You define activities (e.g. "Math homework") with a domain whitelist; while a session is active, every other site is blocked. Try to visit a blocked site and an AI gatekeeper asks why you need it. Plausible reasons get a 10-minute pass; bad ones don't.

Ports the macOS Locus app's core loop to Chrome (Manifest V3).

## Install (developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select this directory.
4. Pin Locus from the puzzle-piece menu so the popup is one click away.
5. Click **Settings** in the popup to manage activities, domains, and the override code.

## How it works

- **Background service worker** watches `chrome.webNavigation` and redirects blocked URLs to an internal `blocked.html` page.
- The blocked page first asks the AI gatekeeper if the bare site is obviously relevant (auto-allow). If it isn't, the user types a reason and the AI decides.
- Approvals grant a temporary allow stored in `chrome.storage.local` (default: 10 minutes).
- The override code is a fallback escape hatch — set it to something tedious so future-you thinks twice.

## AI proxy

All AI calls go to `https://locus-proxy.locus-proxy.workers.dev/`. The Cloudflare Worker holds the upstream API key as a server secret and rate-limits per `device_id` (a UUID generated on first run).

## Files

- `manifest.json` — MV3 manifest
- `background.js` — service worker (navigation interception, message routing)
- `lib/storage.js` — storage helpers + defaults
- `lib/ai.js` — worker client + prompt templates
- `popup.html / popup.js` — start/stop sessions, allowed-domain list
- `options.html / options.js` — manage activities, always-allowed list, override code
- `blocked.html / blocked.js` — the gatekeeper page

## Limitations

- Doesn't intercept service-worker-controlled SPA route changes that don't fire `webNavigation`. (Most navigations do.)
- No syncing across devices — `chrome.storage.local` only.
- No analytics, no telemetry.
