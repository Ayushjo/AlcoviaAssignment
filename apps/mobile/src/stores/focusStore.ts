import { create } from 'zustand';
import { getDb } from '../db/client';
import { STUDENT_ID } from '../constants';
import type { RewardState, SessionStatus, FailReason } from '../sync/types';

export interface ActiveSession {
  id: string;
  targetDuration: number; // seconds
  startedAt: string;
  elapsed: number;        // seconds elapsed so far
}

interface FocusStore {
  activeSession: ActiveSession | null;
  rewards: RewardState;
  isLoading: boolean;

  loadRewards: () => Promise<void>;
  setActiveSession: (session: ActiveSession | null) => void;
  tickElapsed: () => void;
  setRewards: (rewards: RewardState) => void;
}

const DEFAULT_REWARDS: RewardState = {
  coins: 0,
  focusStreak: 0,
  todayFocusMinutes: 0,
  lastFocusDate: null,
};

export const useFocusStore = create<FocusStore>((set) => ({
  activeSession: null,
  rewards: DEFAULT_REWARDS,
  isLoading: false,

  loadRewards: async () => {
    set({ isLoading: true });
    try {
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
    } finally {
      set({ isLoading: false });
    }
  },

  setActiveSession: (session) => set({ activeSession: session }),

  tickElapsed: () =>
    set((state) => ({
      activeSession: state.activeSession
        ? { ...state.activeSession, elapsed: state.activeSession.elapsed + 1 }
        : null,
    })),

  setRewards: (rewards) => set({ rewards }),
}));
