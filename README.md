# Locus — Chrome Extension

A focus extension. You define activities (e.g. "Math homework") with a domain whitelist; while a session is active, every other site is blocked. Try to visit a blocked site and an AI gatekeeper asks why you need it. Plausible reasons get a temporary pass; bad ones don't.

Ports the macOS Locus app's core loop to Chrome (Manifest V3).
dsfsdf
## Install (developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select this directory.
4. Pin Locus from the puzzle-piece menu so the popup is one click away.
5. The popup shows only Start/Stop. Click **Dashboard** (top right of the popup) for activities, calendar, analytics, and settings — or right-click the icon → **Options**.

## How it works

- **Background service worker** watches `chrome.webNavigation` and redirects blocked URLs to an internal `blocked.html` page.
- The blocked page asks the AI gatekeeper if the bare site is obviously relevant (auto-allow). If it isn't, the user types a reason and the AI decides.
- Approvals grant a temporary allow stored in `chrome.storage.local` (default: 10 minutes).
- The override code is a fallback escape hatch — set it to something tedious so future-you thinks twice.

## UI surfaces

- **Popup** (`popup.html`) — small, fast. Pick activity + task → Start. While active: timer, current task (editable inline), End session.
- **Dashboard** (`dashboard.html`) — full browser tab. Five sections via top-tab nav:
  - **Activities** — create/edit/delete activities, manage per-activity domain whitelists, plus an "Always allowed" list.
  - **Calendar** — manage iCal feeds, define keyword→activity mappings, manual "Sync now," view upcoming auto-starts.
  - **Analytics** — focus minutes, streak, blocking stats, 14-day series, by-activity breakdown, top blocked domains.
  - **Settings** — temp-allow duration, harshness, drift detection on/off + interval, sound on block, theme, override code, and an Advanced collapsible with the three editable AI prompts.
  - **About** — version, link, brief feature summary.

## Calendar (iCal feeds)

Locus subscribes to one or more `.ics` URLs the user pastes in (each entry is `{name, url}`). On a 30-minute alarm (and on demand), the extension does a plain `fetch()` of each feed, parses it inline, and expands recurring events for the next ~14 days. Event titles are matched (case-insensitive substring) against keyword→activity mappings; matched entries with `auto-start` schedule a `chrome.alarms` call to start the corresponding session at the event's start time.

Supported feed sources include:

- **Google Calendar** — `Settings → Integrate calendar → Secret address in iCal format`
- **iCloud / Apple Calendar** — Calendar Share → Public Calendar URL
- **Outlook 365** — Calendar settings → Publish a calendar → ICS link
- **Schoology** — User profile → Calendar → iCal feed
- **Canvas** — Calendar → Calendar Feed

The inline parser is intentionally minimal (~250 lines, no external libraries):

- VEVENT only.
- DTSTART / DTEND / SUMMARY / DESCRIPTION / LOCATION / UID / RRULE / EXDATE.
- RRULE expansion handles `FREQ=DAILY` and `FREQ=WEEKLY` with optional `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`. `MONTHLY`/`YEARLY` events surface only their first instance.
- Folded lines are unfolded; UTC `Z` and floating times are honored. TZID values are treated as local wall-clock — close enough for auto-start.

### CORS caveat

`fetch()` from a Chrome extension hits CORS on a few iCal hosts. Most public/secret iCal endpoints (Google, iCloud, Schoology, Canvas) reply with `Access-Control-Allow-Origin: *` and work fine. If a feed fails, the dashboard shows the error per-feed; switch to a different export URL or a different provider.

## Features

- **Per-session task.** When starting a session, type one line about what you're working on. Passed into every AI prompt as additional context. Editable mid-session from the popup.
- **Smart re-blocking.** While a temp-allow is active, the background polls each tab's title every ~15s and asks the AI whether you're drifting. If you are, the temp-allow is revoked and you're sent back to the blocked page with the AI's drift reason.
- **Tightened denial UX.** When the AI denies a request, the textarea is replaced by a denial card showing the reason. Refreshing the same tab keeps the denial in place; closing the tab or navigating to a different domain clears it.
- **Analytics.** Local-only event log. Focus minutes today/week, streak, sessions, block attempts, AI approvals/denials, drift revocations, top blocked domains, 14-day bar chart, and per-activity breakdown.
- **iCal calendar import.** No OAuth, no Notion. Just paste an `.ics` URL.
- **Settings parity** with the macOS app: temp-allow duration, harshness (Lenient / Standard / Strict), sound on block, theme (light/dark/system), and an Advanced section to override the three AI prompts (`evaluate_reason`, `evaluate_site_relevance`, `evaluate_title`).

## AI proxy

All AI calls go to `https://locus-proxy.locus-proxy.workers.dev/`. The Cloudflare Worker holds the upstream API key as a server secret and rate-limits per `device_id` (a UUID generated on first run).

## Files

- `manifest.json` — MV3 manifest
- `background.js` — service worker (navigation, drift sweep, calendar alarms, analytics, denial locks)
- `popup.html / popup.js` — compact pinned-icon popup (Session only)
- `dashboard.html / dashboard.js` — full-tab dashboard (Activities, Calendar, Analytics, Settings, About)
- `blocked.html / blocked.js` — gatekeeper page with denial-lock UX
- `lib/storage.js` — schema + helpers
- `lib/ai.js` — worker client + prompt templates
- `lib/analytics.js` — event log + summary
- `lib/calendar.js` — iCal fetch + inline parser + RRULE expansion + mapping
- `lib/theme.js` — theme bootstrap

## Permissions

`storage`, `tabs`, `webNavigation`, `alarms`, `scripting`, `notifications`, plus `<all_urls>` host permission. (No `identity` permission anymore — calendar is iCal, not OAuth.)

## Not implemented (and why)

- **Smart App Blocking** — extensions can't kill native apps; macOS-only.
- **Notion connector** — intentionally skipped.
- **Safari/Firefox** — out of scope.
- **Complex RRULE patterns** (monthly-by-weekday, BYMONTH, BYSETPOS) — surface only the first occurrence. Handles the common "every Tuesday" / "every weekday" cases that cover ~99% of real schedules.

## Limitations

- Doesn't intercept service-worker-controlled SPA route changes that don't fire `webNavigation`.
- No syncing across devices — `chrome.storage.local` only.
- No tracking, no telemetry. All analytics are local.
