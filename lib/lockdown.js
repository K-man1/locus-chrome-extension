// Lockdown window math. A lockdown config is:
//   { enabled, startHour, startMin, endHour, endMin, days:[0-6], tasks:[...], lastTask }
// days use JS getDay() numbering (0 = Sunday, 1 = Monday … 6 = Saturday).
//
// The *config* only decides when a lock may START. Once a lock is running it is
// pinned by a separate `lockCommit` latch (see background.js) so that editing or
// disabling the config mid-window can't release you early — that's the whole
// point of a commitment device.

// Absolute epoch ms of today's window start/end for the given config.
export function windowBounds(lock, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    lock.startHour, lock.startMin, 0, 0).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    lock.endHour, lock.endMin, 0, 0).getTime();
  return { start, end };
}

// Is this config complete enough to arm? Returns "" when it is, else a one-line
// reason. Single source of truth: the dashboard gates the toggle on it and
// enforcement refuses to latch without it, so a half-built config can never
// lock you into a session with no tasks to pick from.
export function lockConfigError(lock) {
  if (!lock) return "Nothing configured yet.";
  const t = [lock.startHour, lock.startMin, lock.endHour, lock.endMin];
  if (!t.every(Number.isFinite)) return "Set a start and end time.";
  if (lock.endHour * 60 + lock.endMin <= lock.startHour * 60 + lock.startMin) {
    return "End must be after start.";
  }
  if (!Array.isArray(lock.days) || !lock.days.length) return "Pick at least one day.";
  if (!Array.isArray(lock.tasks) || !lock.tasks.length) return "Add at least one task.";
  return "";
}

// Is `now` inside today's lock window? Enabled, valid, right weekday, start <= now < end.
// Half-open interval so the lock releases exactly at the end hour, never re-arms.
export function inLockWindow(lock, now = new Date()) {
  if (!lock || !lock.enabled) return false;
  if (lockConfigError(lock)) return false;
  if (!lock.days.includes(now.getDay())) return false;
  const { start, end } = windowBounds(lock, now);
  const t = now.getTime();
  return t >= start && t < end;
}

// Start of the next window that hasn't begun yet, or null if the config can't
// arm. Today counts only if its start is still in the future — once we're past
// it the answer is the next selected weekday, so this never points at a window
// you're already inside.
export function nextWindowStart(lock, now = new Date()) {
  if (!lock || !lock.enabled || lockConfigError(lock)) return null;
  for (let ahead = 0; ahead < 8; ahead++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead,
      lock.startHour, lock.startMin, 0, 0);
    if (lock.days.includes(d.getDay()) && d.getTime() > now.getTime()) return d;
  }
  return null;
}

// Is `task` one of the allowed lockdown tasks? Used to reject arbitrary tasks
// (or clearing the task) while a lock is active.
export function allowedTask(lock, task) {
  return Array.isArray(lock?.tasks) && lock.tasks.includes(task);
}

// ─── Per-lockdown setting overrides ─────────────────────────────────────────
// A lockdown carries its own copy of the settings that decide how strict the
// session is. While the lock is live those win; the rest of the time the
// globals do. Nothing is copied into the global keys — the override is applied
// at read time — so a lock can never leave the user's normal settings altered
// behind it, even if the worker dies mid-window.
export const OVERRIDE_KEYS = [
  "pomodoroEnabled", "pomodoroWorkMin", "pomodoroBreakMin", "harshness", "alwaysAllowed"
];

// Is a lock latched right now? Keyed on lockCommit (the latch), not on
// lockdown.enabled, for the same reason enforcement is.
export function lockActive(state, now = Date.now()) {
  return !!(state && state.lockCommit && state.lockCommit.until > now);
}

// The settings that actually apply right now. Consumers deciding *behavior*
// read this; the dashboard's global settings pane keeps reading the raw state
// so it edits the globals rather than the override.
export function resolveSettings(state, now = Date.now()) {
  const out = {
    pomodoroEnabled: !!state.pomodoroEnabled,
    pomodoroWorkMin: state.pomodoroWorkMin,
    pomodoroBreakMin: state.pomodoroBreakMin,
    harshness: state.harshness,
    alwaysAllowed: state.alwaysAllowed || [],
    locked: false
  };
  if (!lockActive(state, now)) return out;
  out.locked = true;
  const ov = state.lockdown?.overrides || {};
  // null/undefined means "inherit the global" — that's how the allowlist opts
  // out of a tighter list without needing a second flag in storage.
  for (const k of OVERRIDE_KEYS) {
    if (ov[k] !== undefined && ov[k] !== null) out[k] = ov[k];
  }
  return out;
}
