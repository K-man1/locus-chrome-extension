// Pomodoro phase math + session timing. Shared by background, popup, dashboard.

// Work and break lengths are both user-configurable. Callers pass the chosen
// lengths (minutes) so every surface reads the same clock. The presets are just
// convenient starting points offered in the UI — any positive length is valid.
export const POMO_WORK_OPTIONS = [15, 25, 45, 60];
export const POMO_WORK_MIN_DEFAULT = 25;
export const POMO_BREAK_MIN_DEFAULT = 5;
export const POMO_BREAK_MS = POMO_BREAK_MIN_DEFAULT * 60 * 1000;

// Coerce a stored minute value to a usable positive number, else the default.
export function pomoMinutes(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getPomoPhase(elapsedMs, workMin = POMO_WORK_MIN_DEFAULT, breakMin = POMO_BREAK_MIN_DEFAULT) {
  const workMs = pomoMinutes(workMin, POMO_WORK_MIN_DEFAULT) * 60 * 1000;
  const breakMs = pomoMinutes(breakMin, POMO_BREAK_MIN_DEFAULT) * 60 * 1000;
  const cycleMs = workMs + breakMs;
  const cyclePos = elapsedMs % cycleMs;
  const round = Math.floor(elapsedMs / cycleMs) + 1;
  if (cyclePos < workMs) {
    return { phase: "work", remaining: workMs - cyclePos, round };
  }
  return { phase: "break", remaining: cycleMs - cyclePos, round };
}

// Elapsed focus time for a session, excluding any paused stretches.
// While paused (session.pausedAt is set) the value is frozen.
export function sessionElapsed(session, now = Date.now()) {
  if (!session || !session.startedAt) return 0;
  const pausedMs = session.pausedMs || 0;
  const anchor = session.pausedAt || now;
  return Math.max(0, anchor - session.startedAt - pausedMs);
}

export function isPaused(session) {
  return !!(session && session.pausedAt);
}
