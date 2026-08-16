// Scheduled sessions: auto-start a focus session on chosen days/times.
// A schedule is { id, taskText, days:[0-6], time:"HH:MM", enabled, lastFired }
// where days use JS getDay() numbering (0 = Sunday) and lastFired is the
// "YYYY-MM-DD" local date key of the last day this schedule fired (so a
// schedule only ever starts one session per day).

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function makeScheduleId() {
  return "sch-" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

// Local "YYYY-MM-DD" key for a given date.
export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// How long after its scheduled time a session may still auto-start. This has to
// be generous: MV3 service workers sleep and chrome.alarms ticks are best-effort
// (Chrome delays/coalesces them when the machine is idle, busy, or asleep), so a
// tight window means a delayed tick misses the slot and the schedule never fires
// that day. 15 min absorbs that jitter and short lid-closes without auto-starting
// a stale session hours late.
export const FIRE_WINDOW_MS = 15 * 60 * 1000;

// Schedules that are due to fire at `now`: enabled, matching today's weekday,
// not already fired today, and whose time is now or recently passed (within
// windowMs — the catch-up window above).
export function dueSchedules(schedules, now = new Date(), windowMs = FIRE_WINDOW_MS) {
  const today = dateKey(now);
  const dow = now.getDay();
  return (schedules || []).filter((s) => {
    if (!s || !s.enabled) return false;
    if (!Array.isArray(s.days) || !s.days.includes(dow)) return false;
    if (s.lastFired === today) return false;
    const [h, m] = String(s.time || "").split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
    const sched = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0).getTime();
    const delta = now.getTime() - sched;
    return delta >= 0 && delta < windowMs;
  });
}
