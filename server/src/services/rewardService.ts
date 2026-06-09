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
 * Grant coins, streak, and focus-minute rewards for all completed sessions that
 * haven't had rewards applied yet.
 *
 * Idempotency guarantee:
 *   The UPDATE ... WHERE reward_granted = 0 acts as an atomic claim. If two sync
 *   requests for the same student arrive concurrently (two devices), the SQLite
 *   transaction serialises them and only the first UPDATE actually changes a row.
 *   The second call gets changes === 0 and skips the reward.
 *
 * Returns the session IDs that were freshly rewarded this call (used by n8nService).
 */
export function processRewards(studentId: string): { newSuccessSessionIds: string[] } {
  const db = getDb();

  // Find completed sessions with reward not yet granted
  const pendingSessions = db.prepare(`
    SELECT id, actual_duration, started_at
    FROM sessions
    WHERE student_id = ? AND status = 'completed' AND reward_granted = 0
    ORDER BY started_at ASC
  `).all(studentId) as Array<{
    id: string;
    actual_duration: number | null;
    started_at: string;
  }>;

  if (pendingSessions.length === 0) return { newSuccessSessionIds: [] };

  const newSuccessSessionIds: string[] = [];
  const today = todayDate();

  const grantAll = db.transaction(() => {
    for (const session of pendingSessions) {
      // Atomic claim: flip reward_granted only if still 0
      const claim = db.prepare(`
        UPDATE sessions SET reward_granted = 1 WHERE id = ? AND reward_granted = 0
      `).run(session.id);

      if (claim.changes === 0) continue; // already claimed by a concurrent request

      newSuccessSessionIds.push(session.id);

      const minutes = Math.floor((session.actual_duration ?? 0) / 60);
      const sessionDate = dateOnly(session.started_at);

      // Read current reward state inside the transaction for consistency
      const current = db.prepare(`
        SELECT coins, focus_streak, today_focus_minutes, last_focus_date
        FROM student_rewards WHERE student_id = ?
      `).get(studentId) as {
        coins: number;
        focus_streak: number;
        today_focus_minutes: number;
        last_focus_date: string | null;
      };

      const newCoins = current.coins + COINS_PER_SESSION;

      // today_focus_minutes resets if the session date is not today
      const newMinutes =
        sessionDate === today
          ? current.today_focus_minutes + minutes
          : minutes;

      // Streak calculation based on the session's date vs the last recorded focus date
      let newStreak = current.focus_streak;
      const lastDate = current.last_focus_date;

      if (!lastDate) {
        newStreak = 1;
      } else {
        const lastMs = new Date(lastDate).getTime();
        const currMs = new Date(sessionDate).getTime();
        const diffDays = Math.round((currMs - lastMs) / 86_400_000);

        if (diffDays === 1) {
          newStreak = current.focus_streak + 1; // consecutive day — extend streak
        } else if (diffDays === 0) {
          // Multiple sessions on the same day — streak stays the same
        } else {
          newStreak = 1; // gap in days — streak resets
        }
      }

      db.prepare(`
        UPDATE student_rewards
        SET coins               = ?,
            focus_streak        = ?,
            today_focus_minutes = ?,
            last_focus_date     = ?,
            updated_at          = datetime('now')
        WHERE student_id = ?
      `).run(newCoins, newStreak, newMinutes, sessionDate, studentId);
    }
  });

  grantAll();
  return { newSuccessSessionIds };
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
