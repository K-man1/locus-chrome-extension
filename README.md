# Locus — Chrome Extension

A focus extension. Type what you're working on (or click an upcoming calendar event), and every site that isn't on your always-allowed list is blocked. Try to visit a blocked page and an AI gatekeeper asks why you need it. Plausible reasons get a temporary pass; bad ones don't.

Mirrors the macOS Locus app's UI — sidebar with **Start / Settings / Connectors / Analytics**, a single task input, and a list of upcoming calendar events you can click to start a session.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select this directory.
4. Pin Locus from the puzzle-piece menu so the popup is one click away.
5. The popup is compact — type a task, hit Start. Click **Open dashboard** at the bottom for the full Start / Settings / Connectors / Analytics view.

## How it works

- A focus session is just a free-form task string — typed manually or pulled from a calendar event title.
- While a session is active, every site is blocked **except** the **Always-allowed** domains in Settings.
- The blocked page asks the AI gatekeeper if the bare site is obviously relevant to the task (auto-allow). If not, the user types a reason and the AI decides.
- Approvals grant a temporary allow stored in `chrome.storage.local` (default: 10 minutes).
- The override code is a fallback escape hatch — set it to something tedious so future-you thinks twice.

## UI surfaces

- **Popup** (`popup.html`) — compact. Idle: lock icon, "Locus", task input, Start Session. Active: timer, current task (editable), End Session.
- **Dashboard** (`dashboard.html`) — full browser tab with a 200px sidebar:
  - **Start** — big lock icon, task input, Start Session, "OR" divider, **UPCOMING** list of calendar events grouped by day. Click any event to start a session with that event's title as the task.
  - **Settings** — Always-allowed domains, override code, temp-allow duration, harshness, drift on/off + interval, sound on block, theme. Advanced collapsible exposes the three AI prompts.
  - **Connectors** — iCal feeds CRUD plus a manual Sync now.
  - **Analytics** — focus minutes, streak, blocking stats, 14-day bar chart, top blocked domains.

## Calendar (iCal feeds)

Locus subscribes to one or more `.ics` URLs (each entry is `{name, url}`). On a 30-minute alarm (and on demand from the Connectors pane), the extension does a plain `fetch()` of each feed, parses it inline, and expands recurring events for the next ~14 days. The Start pane shows them grouped by day with headers ("TODAY", "TOMORROW", "THU APR 30"). Click an event to start a session with `taskText = "<event title> (<feed name>)"`.

Sessions are **never** auto-started — the user always picks.

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
- Folded lines are unfolded; UTC `Z` and floating times are honored. TZID values are treated as local wall-clock.

### CORS caveat

`fetch()` from a Chrome extension hits CORS on a few iCal hosts. Most public/secret iCal endpoints (Google, iCloud, Schoology, Canvas) reply with `Access-Control-Allow-Origin: *` and work fine. If a feed fails, the Connectors pane shows the per-feed error.

## Features

- **Free-form task as session.** No pre-defined activities; just type what you're working on. The string is passed into every AI prompt as the entire context. Editable mid-session.
- **Smart re-blocking.** While a temp-allow is active, the background polls each tab's title every ~15s and asks the AI whether you're drifting. If you are, the temp-allow is revoked and you're sent back to the blocked page with the AI's drift reason.
- **Tightened denial UX.** When the AI denies a request, the textarea is replaced by a denial card. Refreshing the same tab keeps the denial; closing it or navigating to a different domain clears it.
- **Analytics.** Local-only event log. Focus minutes today/week, streak, sessions, block attempts, AI approvals/denials, drift revocations, top blocked domains, 14-day bar chart.
- **iCal calendar import.** No OAuth. Just paste an `.ics` URL per feed.
- **Settings parity** with the macOS app: always-allowed domains, temp-allow duration, harshness (Lenient / Standard / Strict), sound on block, theme (light/dark/system), and an Advanced section to override the three AI prompts (`evaluate_reason`, `evaluate_site_relevance`, `evaluate_title`). Templates support `{task}`, `{domain}`, `{reason}`, `{titleHint}`, `{tabTitle}`, `{harshness}`.

## AI proxy

All AI calls go to `https://locus-proxy.locus-proxy.workers.dev/`. The Cloudflare Worker holds the upstream API key as a server secret and rate-limits per `device_id` (a UUID generated on first run).

## Files

- `manifest.json` — MV3 manifest
- `background.js` — service worker (navigation, drift sweep, calendar sync, analytics, denial locks)
- `popup.html / popup.js` — compact popup matching the Start pane
- `dashboard.html / dashboard.js` — full-tab dashboard (sidebar: Start / Settings / Connectors / Analytics)
- `blocked.html / blocked.js` — gatekeeper page with denial-lock UX
- `lib/storage.js` — schema + helpers + legacy migration
- `lib/ai.js` — worker client + prompt templates
- `lib/analytics.js` — event log + summary
- `lib/calendar.js` — iCal fetch + inline parser + RRULE expansion
- `lib/theme.js` — theme bootstrap

## Permissions

`storage`, `tabs`, `webNavigation`, `alarms`, `scripting`, `notifications`, plus `<all_urls>` host permission.

## Migrating from earlier versions

If you used Locus before activities were removed, the extension drops the old `activities` map and calendar `mappings` on first load and rewrites any `{activity}` placeholder in stored prompt overrides to `{task}`. Domains you previously had on per-activity whitelists are not auto-migrated — re-add the ones you want to **Always allowed** in Settings.

## Limitations

- Doesn't intercept service-worker-controlled SPA route changes that don't fire `webNavigation`.
- No syncing across devices — `chrome.storage.local` only.
- No tracking, no telemetry. All analytics are local.
