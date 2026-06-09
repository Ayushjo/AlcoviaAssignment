import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/client';
import { STUDENT_ID, getDeviceId } from '../constants';
import type { RewardState, FailReason } from '../sync/types';
import { syncEngine } from '../sync/engine';

export interface ActiveSession {
  id: string;
  targetDuration: number; // seconds
  startedAt: string;      // ISO 8601
  elapsed: number;        // seconds elapsed so far
}

export type FocusPhase = 'idle' | 'running' | 'success' | 'failed';

export interface SessionResult {
  coinsEarned: number;
  newStreak: number;
  todayMinutes: number;
}

interface FocusStore {
  phase: FocusPhase;
  activeSession: ActiveSession | null;
  rewards: RewardState;
  lastResult: SessionResult | null;
  failReason: FailReason | null;
  isLoading: boolean;

  loadRewards: () => Promise<void>;
  startSession: (targetDuration: number) => Promise<void>;
  tickElapsed: () => void;
  persistElapsed: () => Promise<void>;
  completeSession: () => Promise<void>;
  failSession: (reason: FailReason) => Promise<void>;
  recoverSession: () => Promise<void>;
  resetToIdle: () => void;
  setRewards: (rewards: RewardState) => void;
}

const DEFAULT_REWARDS: RewardState = {
  coins: 0,
  focusStreak: 0,
  todayFocusMinutes: 0,
  lastFocusDate: null,
};

const COINS_PER_SESSION = 50;

function dateOnly(iso: string): string {
  return iso.split('T')[0];
}

export const useFocusStore = create<FocusStore>((set, get) => ({
  phase: 'idle',
  activeSession: null,
  rewards: DEFAULT_REWARDS,
  lastResult: null,
  failReason: null,
  isLoading: false,

  loadRewards: async () => {
    const db = getDb();
    const row = await db.getFirstAsync<{
      coins: number;
      focus_streak: number;
      today_focus_minutes: number;
      last_focus_date: string | null;
    }>(
      `SELECT coins, focus_streak, today_focus_minutes, last_focus_date
       FROM student_rewards WHERE student_id = ?`,
      [STUDENT_ID]
    );
    if (row) {
      set({
        rewards: {
          coins: row.coins,
          focusStreak: row.focus_streak,
          todayFocusMinutes: row.today_focus_minutes,
          lastFocusDate: row.last_focus_date,
        },
      });
    }
  },

  startSession: async (targetDuration: number) => {
    const db = getDb();
    const deviceId = getDeviceId();
    const id = uuidv4();
    const startedAt = new Date().toISOString();

    // Write an 'active' session to SQLite — crash recovery reads this on next launch
    await db.runAsync(
      `INSERT INTO sessions
         (id, student_id, device_id, target_duration, started_at, status, lamport_clock, synced)
       VALUES (?, ?, ?, ?, ?, 'active', 0, 0)`,
      [id, STUDENT_ID, deviceId, targetDuration, startedAt]
    );

    set({
      phase: 'running',
      activeSession: { id, targetDuration, startedAt, elapsed: 0 },
      lastResult: null,
      failReason: null,
    });
  },

  tickElapsed: () =>
    set((state) => ({
      activeSession: state.activeSession
        ? { ...state.activeSession, elapsed: state.activeSession.elapsed + 1 }
        : null,
    })),

  // Called every 5s — writes elapsed to SQLite so a crash doesn't lose all progress
  persistElapsed: async () => {
    const { activeSession } = get();
    if (!activeSession) return;
    const db = getDb();
    await db.runAsync(
      `UPDATE sessions SET actual_duration = ? WHERE id = ?`,
      [activeSession.elapsed, activeSession.id]
    );
  },

  completeSession: async () => {
    const { activeSession, rewards } = get();
    if (!activeSession) return;

    const db = getDb();
    const endedAt = new Date().toISOString();
    const { id, targetDuration, startedAt, elapsed } = activeSession;

    // 1. Mark session completed in SQLite
    await db.runAsync(
      `UPDATE sessions
       SET status = 'completed', ended_at = ?, actual_duration = ?
       WHERE id = ?`,
      [endedAt, elapsed, id]
    );

    // 2. Enqueue sync op — server will grant authoritative rewards on next sync
    await syncEngine.enqueueOp({
      type: 'SESSION',
      entityId: id,
      payload: {
        targetDuration,
        startedAt,
        endedAt,
        status: 'completed',
        actualDuration: elapsed,
      },
    });

    // 3. Optimistic local reward update so UI shows results immediately (offline-friendly)
    const sessionDate = dateOnly(startedAt);
    const today = dateOnly(new Date().toISOString());
    const minutesEarned = Math.floor(elapsed / 60);

    let newStreak = rewards.focusStreak;
    const lastDate = rewards.lastFocusDate;
    if (!lastDate) {
      newStreak = 1;
    } else {
      const diffDays = Math.round(
        (new Date(sessionDate).getTime() - new Date(lastDate).getTime()) / 86_400_000
      );
      if (diffDays === 1) newStreak = rewards.focusStreak + 1;
      else if (diffDays > 1) newStreak = 1;
      // diffDays === 0: same day, streak unchanged
    }

    const newCoins = rewards.coins + COINS_PER_SESSION;
    const newMinutes =
      sessionDate === today
        ? rewards.todayFocusMinutes + minutesEarned
        : minutesEarned;

    await db.runAsync(
      `UPDATE student_rewards
       SET coins = ?, focus_streak = ?, today_focus_minutes = ?, last_focus_date = ?
       WHERE student_id = ?`,
      [newCoins, newStreak, newMinutes, sessionDate, STUDENT_ID]
    );

    const result: SessionResult = {
      coinsEarned: COINS_PER_SESSION,
      newStreak,
      todayMinutes: newMinutes,
    };

    set({
      phase: 'success',
      activeSession: null,
      lastResult: result,
      rewards: {
        coins: newCoins,
        focusStreak: newStreak,
        todayFocusMinutes: newMinutes,
        lastFocusDate: sessionDate,
      },
    });

    // Background sync — don't await, failure is fine (will retry on next online event)
    syncEngine.sync().catch(() => {});
  },

  failSession: async (reason: FailReason) => {
    const { activeSession } = get();
    if (!activeSession) return;

    const db = getDb();
    const endedAt = new Date().toISOString();
    const { id, targetDuration, startedAt, elapsed } = activeSession;

    await db.runAsync(
      `UPDATE sessions
       SET status = 'failed', fail_reason = ?, ended_at = ?, actual_duration = ?
       WHERE id = ?`,
      [reason, endedAt, elapsed, id]
    );

    await syncEngine.enqueueOp({
      type: 'SESSION',
      entityId: id,
      payload: {
        targetDuration,
        startedAt,
        endedAt,
        status: 'failed',
        failReason: reason,
        actualDuration: elapsed,
      },
    });

    set({ phase: 'failed', activeSession: null, failReason: reason });

    syncEngine.sync().catch(() => {});
  },

  /**
   * Called once on app launch after DB is ready.
   * If there's a dangling 'active' session (e.g. from a crash or forced close):
   *   - elapsed > targetDuration + 5s → auto-fail as app_switch
   *   - Otherwise → resume the session from computed elapsed
   */
  recoverSession: async () => {
    const db = getDb();
    const row = await db.getFirstAsync<{
      id: string;
      target_duration: number;
      started_at: string;
      actual_duration: number | null;
    }>(
      `SELECT id, target_duration, started_at, actual_duration
       FROM sessions WHERE status = 'active' AND student_id = ?`,
      [STUDENT_ID]
    );

    if (!row) return;

    const startedAtMs = new Date(row.started_at).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startedAtMs) / 1000);

    if (elapsedSeconds > row.target_duration + 5) {
      // App was closed/backgrounded for longer than the session — auto-fail
      const endedAt = new Date().toISOString();
      const actualDuration = Math.min(elapsedSeconds, row.target_duration);

      await db.runAsync(
        `UPDATE sessions
         SET status = 'failed', fail_reason = 'app_switch', ended_at = ?, actual_duration = ?
         WHERE id = ?`,
        [endedAt, actualDuration, row.id]
      );

      await syncEngine.enqueueOp({
        type: 'SESSION',
        entityId: row.id,
        payload: {
          targetDuration: row.target_duration,
          startedAt: row.started_at,
          endedAt,
          status: 'failed',
          failReason: 'app_switch',
          actualDuration,
        },
      });

      set({ phase: 'failed', activeSession: null, failReason: 'app_switch' });
    } else {
      // Resume — elapsed time since start is valid (quick reload / tab restore)
      const elapsed = Math.min(elapsedSeconds, row.target_duration);
      set({
        phase: 'running',
        activeSession: {
          id: row.id,
          targetDuration: row.target_duration,
          startedAt: row.started_at,
          elapsed,
        },
        lastResult: null,
        failReason: null,
      });
    }
  },

  resetToIdle: () =>
    set({ phase: 'idle', activeSession: null, lastResult: null, failReason: null }),

  setRewards: (rewards) => set({ rewards }),
}));
