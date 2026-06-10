import type { RewardState } from '@alcovia/shared';
import { getDb } from '../db/schema';

const COINS_PER_SESSION = 50;

function dateOnly(isoString: string): string {
  return isoString.split('T')[0]; // 'YYYY-MM-DD'
}

function todayDate(): string {
  return dateOnly(new Date().toISOString());
}

/**
 * Length of the consecutive-day run ending on the most recent focus day.
 * Input must be distinct 'YYYY-MM-DD' strings sorted ascending.
 *
 * This is a pure function of the *set* of focus dates, so it is completely
 * order-independent: it returns the same streak no matter what order sessions
 * arrived in or how many times sync ran.
 */
function computeStreak(sortedDates: string[]): number {
  if (sortedDates.length === 0) return 0;
  let streak = 1;
  for (let i = sortedDates.length - 1; i > 0; i--) {
    const cur = new Date(sortedDates[i]).getTime();
    const prev = new Date(sortedDates[i - 1]).getTime();
    const diffDays = Math.round((cur - prev) / 86_400_000);
    if (diffDays === 1) streak++;
    else break; // a gap ends the run
  }
  return streak;
}

/**
 * Recompute the derived reward totals (coins, streak, today's minutes, last focus
 * date) purely from the set of completed sessions. This is the heart of reward
 * idempotency: we *derive* state instead of *mutating* it, so replays, out-of-order
 * arrival, and the same session syncing from two devices all converge to the same
 * numbers. The only per-session guard we need (reward_granted) just marks which
 * sessions are *newly observed* so n8n fires once — it does not drive the totals.
 */
function recomputeRewards(studentId: string): void {
  const db = getDb();
  const today = todayDate();

  const agg = db.prepare(`
    SELECT
      COUNT(*) AS completedCount,
      COALESCE(SUM(CASE WHEN date(started_at) = ? THEN actual_duration ELSE 0 END), 0) AS todaySeconds
    FROM sessions
    WHERE student_id = ? AND status = 'completed'
  `).get(today, studentId) as { completedCount: number; todaySeconds: number };

  const dateRows = db.prepare(`
    SELECT DISTINCT date(started_at) AS d
    FROM sessions
    WHERE student_id = ? AND status = 'completed'
    ORDER BY d ASC
  `).all(studentId) as Array<{ d: string }>;

  const dates = dateRows.map((r) => r.d);
  const coins = agg.completedCount * COINS_PER_SESSION;
  const todayMinutes = Math.floor(agg.todaySeconds / 60);
  const streak = computeStreak(dates);
  const lastFocusDate = dates.length ? dates[dates.length - 1] : null;

  db.prepare(`
    UPDATE student_rewards
    SET coins               = ?,
        focus_streak        = ?,
        today_focus_minutes = ?,
        last_focus_date     = ?,
        updated_at          = datetime('now')
    WHERE student_id = ?
  `).run(coins, streak, todayMinutes, lastFocusDate, studentId);
}

/**
 * Observe newly completed sessions and recompute reward totals.
 *
 * Idempotency, in two parts:
 *   1. The UPDATE ... WHERE reward_granted = 0 atomic claim identifies sessions we
 *      have not seen before. If two sync requests for the same student race, SQLite
 *      serialises them and only the first claims a given session — so each session
 *      is reported as "new" exactly once (this drives n8n firing exactly once).
 *   2. The totals (coins/streak/today) are *recomputed from scratch* from all
 *      completed sessions, never incremented. So they are correct regardless of
 *      arrival order or replays, and identical on every device after sync.
 *
 * Returns the session IDs freshly observed this call (used by n8nService).
 */
export function processRewards(studentId: string): { newSuccessSessionIds: string[] } {
  const db = getDb();

  const run = db.transaction(() => {
    const pendingSessions = db.prepare(`
      SELECT id FROM sessions
      WHERE student_id = ? AND status = 'completed' AND reward_granted = 0
      ORDER BY started_at ASC
    `).all(studentId) as Array<{ id: string }>;

    const newSuccessSessionIds: string[] = [];
    const claim = db.prepare(
      `UPDATE sessions SET reward_granted = 1 WHERE id = ? AND reward_granted = 0`
    );
    for (const session of pendingSessions) {
      if (claim.run(session.id).changes > 0) newSuccessSessionIds.push(session.id);
    }

    // Always recompute — even when nothing is new — so derived totals stay correct
    // (e.g. when "today" rolls over or sessions were merged by another device).
    recomputeRewards(studentId);

    return { newSuccessSessionIds };
  });

  return run();
}

export function getRewardState(studentId: string): RewardState {
  const db = getDb();

  const row = db.prepare(`
    SELECT coins, focus_streak, today_focus_minutes, last_focus_date
    FROM student_rewards WHERE student_id = ?
  `).get(studentId) as {
    coins: number;
    focus_streak: number;
    today_focus_minutes: number;
    last_focus_date: string | null;
  } | undefined;

  return {
    coins: row?.coins ?? 0,
    focusStreak: row?.focus_streak ?? 0,
    todayFocusMinutes: row?.today_focus_minutes ?? 0,
    lastFocusDate: row?.last_focus_date ?? null,
  };
}
