// iCal subscription fetcher + parser for Locus.
//
// The user pastes one or more public/secret .ics URLs (Google "Secret iCal
// address," iCloud, Outlook, Schoology, Canvas — anything that emits
// iCalendar). We do a plain HTTP GET via fetch(), parse with a minimal
// vanilla parser, and expand recurring events for the next ~14 days.
//
// Limitations of the inline parser (kept deliberately small — no external
// libs, no build step):
//   - VEVENT only (VTODO, VJOURNAL, VFREEBUSY ignored).
//   - DTSTART / DTEND / SUMMARY / DESCRIPTION / LOCATION / UID / RRULE.
//   - RRULE expansion handles FREQ=DAILY and FREQ=WEEKLY only, with optional
//     INTERVAL, COUNT, UNTIL, BYDAY (weekly). FREQ=MONTHLY/YEARLY events
//     surface only their first occurrence — fine for "Math class" weekly
//     schedules, not fine for "first Tuesday of the month" rules.
//   - EXDATE is honored (date-level match).
//   - Timezones: TZID is parsed but not converted; floating times and UTC
//     "Z" times are handled. For TZID values we treat the wall-clock time
//     as local — close enough for auto-start purposes.
//   - Folded lines (RFC 5545 line continuation) are unfolded.
//
// CORS: most public/secret iCal URLs (Google, iCloud, Schoology, Canvas)
// allow GET from any origin. If a feed fails with a CORS error, surface it
// in the dashboard so the user knows to use a different export URL.

import { getState, setState } from "./storage.js";

// ── Public API ────────────────────────────────────────────────────────────

export async function fetchUpcomingEvents(daysAhead = 14) {
  const { calendar } = await getState();
  const feeds = calendar?.feeds || [];
  if (!feeds.length) {
    await setState({ calendar: { ...calendar, upcoming: [], lastSyncedAt: Date.now(), lastErrors: [] } });
    return [];
  }
  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 86_400_000);

  const all = [];
  const errors = [];
  for (const feed of feeds) {
    const url = (feed?.url || "").trim();
    const name = (feed?.name || "").trim() || "Calendar";
    if (!url) continue;
    try {
      const text = await fetchFeed(url);
      const events = parseICS(text);
      const expanded = expandEvents(events, now, end);
      for (const ev of expanded) {
        all.push({
          id: `${name}:${ev.uid || ev.summary}:${ev.startTs}`,
          title: ev.summary || "(untitled)",
          start: new Date(ev.startTs).toISOString(),
          end: ev.endTs ? new Date(ev.endTs).toISOString() : "",
          source: name
        });
      }
    } catch (e) {
      errors.push({ name, url, error: String(e?.message || e) });
    }
  }
  all.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  await setState({
    calendar: {
      ...calendar,
      upcoming: all,
      lastSyncedAt: Date.now(),
      lastErrors: errors
    }
  });
  return all;
}

export function matchMapping(eventTitle, mappings) {
  const t = (eventTitle || "").toLowerCase();
  for (const m of mappings || []) {
    const kw = (m.keyword || "").toLowerCase().trim();
    if (!kw) continue;
    if (t.includes(kw)) return m;
  }
  return null;
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchFeed(url) {
  // webcal:// → https:// (some providers hand out webcal URLs).
  let u = url;
  if (u.startsWith("webcal://")) u = "https://" + u.slice("webcal://".length);
  else if (u.startsWith("webcals://")) u = "https://" + u.slice("webcals://".length);

  const resp = await fetch(u, {
    method: "GET",
    headers: { "Accept": "text/calendar, text/plain, */*" },
    cache: "no-store"
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

// ── ICS Parser ────────────────────────────────────────────────────────────

// Unfold lines (RFC 5545: a line beginning with space/tab continues the prior).
function unfold(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// Split "KEY;PARAM=VAL:value" → { key, params, value }
function parseLine(raw) {
  const colon = raw.indexOf(":");
  if (colon < 0) return null;
  const head = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  const segs = head.split(";");
  const key = segs[0].toUpperCase();
  const params = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf("=");
    if (eq > 0) params[segs[i].slice(0, eq).toUpperCase()] = segs[i].slice(eq + 1);
  }
  return { key, params, value };
}

function unescapeText(s) {
  return String(s || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// Parse an iCal datetime/date string to a millisecond timestamp.
// Returns { ts, allDay }.
function parseDateValue(value, params) {
  const v = (value || "").trim();
  const isAllDay = (params?.VALUE === "DATE") || /^\d{8}$/.test(v);
  if (isAllDay) {
    // YYYYMMDD — treat as local midnight.
    const y = +v.slice(0, 4), mo = +v.slice(4, 6) - 1, d = +v.slice(6, 8);
    return { ts: new Date(y, mo, d).getTime(), allDay: true };
  }
  // YYYYMMDDTHHMMSS or with trailing Z.
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return { ts: NaN, allDay: false };
  const [, Y, Mo, D, H, Mi, S, Z] = m;
  if (Z === "Z") {
    return { ts: Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S), allDay: false };
  }
  // Floating or TZID — treat as local wall-clock. Good enough for auto-start.
  return { ts: new Date(+Y, +Mo - 1, +D, +H, +Mi, +S).getTime(), allDay: false };
}

// Parse an RRULE string into { freq, interval, count, until, byday[] }.
function parseRRule(value) {
  const out = { freq: "", interval: 1, count: 0, until: 0, byday: [] };
  for (const part of String(value || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1);
    if (k === "FREQ") out.freq = v.toUpperCase();
    else if (k === "INTERVAL") out.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (k === "COUNT") out.count = parseInt(v, 10) || 0;
    else if (k === "UNTIL") out.until = parseDateValue(v, {}).ts || 0;
    else if (k === "BYDAY") out.byday = v.split(",").map((d) => d.trim().toUpperCase());
  }
  return out;
}

// Walk an unfolded line stream, yielding VEVENT records.
export function parseICS(text) {
  const lines = unfold(text);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw) continue;
    const u = raw.toUpperCase();
    if (u === "BEGIN:VEVENT") { cur = { exdate: [] }; continue; }
    if (u === "END:VEVENT") {
      if (cur && cur.startTs) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseLine(raw);
    if (!p) continue;
    switch (p.key) {
      case "SUMMARY":     cur.summary = unescapeText(p.value); break;
      case "DESCRIPTION": cur.description = unescapeText(p.value); break;
      case "LOCATION":    cur.location = unescapeText(p.value); break;
      case "UID":         cur.uid = p.value; break;
      case "DTSTART": {
        const { ts, allDay } = parseDateValue(p.value, p.params);
        cur.startTs = ts; cur.allDay = allDay;
        break;
      }
      case "DTEND": {
        const { ts } = parseDateValue(p.value, p.params);
        cur.endTs = ts;
        break;
      }
      case "RRULE":  cur.rrule = parseRRule(p.value); break;
      case "EXDATE": {
        for (const piece of p.value.split(",")) {
          const { ts } = parseDateValue(piece, p.params);
          if (ts) cur.exdate.push(ts);
        }
        break;
      }
    }
  }
  return events;
}

// ── Recurrence expansion ──────────────────────────────────────────────────

const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function isExcluded(ts, exdates) {
  if (!exdates?.length) return false;
  // Match at day granularity to be tolerant of TZ noise.
  const a = new Date(ts);
  for (const ex of exdates) {
    const b = new Date(ex);
    if (a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate()) return true;
  }
  return false;
}

function instance(ev, ts) {
  const dur = (ev.endTs && ev.startTs) ? (ev.endTs - ev.startTs) : 0;
  return {
    uid: ev.uid,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    allDay: !!ev.allDay,
    startTs: ts,
    endTs: dur ? ts + dur : 0
  };
}

// Expand a single VEVENT (with optional RRULE) into instances within
// [windowStart, windowEnd]. Returns an array of {summary, startTs, …}.
export function expandEvent(ev, windowStart, windowEnd) {
  const out = [];
  if (!ev.startTs) return out;
  const wsTs = windowStart instanceof Date ? windowStart.getTime() : windowStart;
  const weTs = windowEnd instanceof Date ? windowEnd.getTime() : windowEnd;

  if (!ev.rrule || !ev.rrule.freq) {
    if (ev.startTs >= wsTs && ev.startTs <= weTs && !isExcluded(ev.startTs, ev.exdate)) {
      out.push(instance(ev, ev.startTs));
    }
    return out;
  }

  const { freq, interval, count, until, byday } = ev.rrule;
  const hardCap = 500; // safety: don't run away on malformed feeds
  let produced = 0;
  let emitted = 0;
  const stopTs = until ? Math.min(weTs, until) : weTs;

  if (freq === "DAILY") {
    let cur = ev.startTs;
    while (cur <= stopTs && produced < hardCap) {
      if ((!count || emitted < count) && cur >= wsTs && !isExcluded(cur, ev.exdate)) {
        out.push(instance(ev, cur));
      }
      emitted++;
      if (count && emitted >= count) break;
      // step by INTERVAL days
      const d = new Date(cur);
      d.setDate(d.getDate() + interval);
      cur = d.getTime();
      produced++;
    }
    return out;
  }

  if (freq === "WEEKLY") {
    // If BYDAY is set, expand within each interval-week to those weekdays.
    // Otherwise step by 7*INTERVAL days from DTSTART.
    if (byday && byday.length) {
      // Anchor: the Sunday-of-week of DTSTART.
      const startDate = new Date(ev.startTs);
      const weekAnchor = new Date(startDate);
      weekAnchor.setDate(startDate.getDate() - startDate.getDay()); // back to Sunday
      weekAnchor.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds(), 0);
      let weekIdx = 0;
      while (true) {
        const weekStart = new Date(weekAnchor);
        weekStart.setDate(weekAnchor.getDate() + 7 * interval * weekIdx);
        if (weekStart.getTime() > stopTs + 7 * 86_400_000) break;
        for (const code of byday) {
          const dow = WEEKDAY_INDEX[code];
          if (dow == null) continue;
          const occ = new Date(weekStart);
          occ.setDate(weekStart.getDate() + dow);
          const ts = occ.getTime();
          if (ts < ev.startTs) continue;
          if (ts > stopTs) continue;
          if (count && emitted >= count) return out;
          emitted++;
          if (ts >= wsTs && !isExcluded(ts, ev.exdate)) out.push(instance(ev, ts));
        }
        weekIdx++;
        if (++produced > hardCap) break;
      }
      return out;
    }
    // No BYDAY: step weekly.
    let cur = ev.startTs;
    while (cur <= stopTs && produced < hardCap) {
      if ((!count || emitted < count) && cur >= wsTs && !isExcluded(cur, ev.exdate)) {
        out.push(instance(ev, cur));
      }
      emitted++;
      if (count && emitted >= count) break;
      const d = new Date(cur);
      d.setDate(d.getDate() + 7 * interval);
      cur = d.getTime();
      produced++;
    }
    return out;
  }

  // Other FREQ values (MONTHLY/YEARLY) — surface only the first occurrence.
  if (ev.startTs >= wsTs && ev.startTs <= weTs && !isExcluded(ev.startTs, ev.exdate)) {
    out.push(instance(ev, ev.startTs));
  }
  return out;
}

export function expandEvents(events, windowStart, windowEnd) {
  const out = [];
  for (const ev of events) {
    out.push(...expandEvent(ev, windowStart, windowEnd));
  }
  return out;
}
