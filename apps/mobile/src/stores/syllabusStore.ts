import { create } from 'zustand';
import { TASK_DEFINITIONS } from '@alcovia/shared';
import { getDb, incrementAndGetLamportClock } from '../db/client';
import { STUDENT_ID, getDeviceId } from '../constants';
import { syncEngine } from '../sync/engine';
import type { TaskStatus, SubjectProgress, ChapterProgress } from '../sync/types';

export interface TaskRow {
  taskId: string;
  subjectId: string;
  chapterId: string;
  title: string;
  subjectName: string;
  chapterName: string;
  status: TaskStatus;
  lamportClock: number;
  deviceId: string;
  synced: boolean;
}

interface SyllabusStore {
  tasks: TaskRow[];
  subjects: SubjectProgress[];
  isLoading: boolean;

  loadTasks: () => Promise<void>;
  updateTaskStatus: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  refreshAfterSync: () => Promise<void>;
}

// ── Progress rollup ───────────────────────────────────────────────────────────
// chapter % = done / total tasks
// subject % = average of its chapter percents
// Both are computed in pure JS so they update instantly offline.
function computeProgress(tasks: TaskRow[]): SubjectProgress[] {
  const subjectMap = new Map<string, SubjectProgress>();

  for (const task of tasks) {
    if (!subjectMap.has(task.subjectId)) {
      subjectMap.set(task.subjectId, {
        subjectId: task.subjectId,
        subjectName: task.subjectName,
        chapters: [],
        percent: 0,
      });
    }
    const subject = subjectMap.get(task.subjectId)!;

    let chapter = subject.chapters.find((c) => c.chapterId === task.chapterId);
    if (!chapter) {
      chapter = {
        chapterId: task.chapterId,
        chapterName: task.chapterName,
        totalTasks: 0,
        completedTasks: 0,
        percent: 0,
      } as ChapterProgress;
      subject.chapters.push(chapter);
    }

    chapter.totalTasks += 1;
    if (task.status === 'done') chapter.completedTasks += 1;
    chapter.percent =
      chapter.totalTasks > 0
        ? Math.round((chapter.completedTasks / chapter.totalTasks) * 100)
        : 0;
  }

  for (const subject of subjectMap.values()) {
    subject.percent =
      subject.chapters.length > 0
        ? Math.round(
            subject.chapters.reduce((sum, c) => sum + c.percent, 0) / subject.chapters.length
          )
        : 0;
  }

  return Array.from(subjectMap.values());
}

export const useSyllabusStore = create<SyllabusStore>((set, get) => ({
  tasks: [],
  subjects: [],
  isLoading: false,

  loadTasks: async () => {
    set({ isLoading: true });
    try {
      const db = getDb();
      const rows = await db.getAllAsync<{
        task_id: string;
        status: string;
        lamport_clock: number;
        device_id: string;
        synced: number;
      }>(
        `SELECT task_id, status, lamport_clock, device_id, synced
         FROM task_states WHERE student_id = ?`,
        [STUDENT_ID]
      );

      const statusMap = new Map(rows.map((r) => [r.task_id, r]));

      const tasks: TaskRow[] = TASK_DEFINITIONS.map((def) => {
        const row = statusMap.get(def.id);
        return {
          taskId: def.id,
          subjectId: def.subjectId,
          chapterId: def.chapterId,
          title: def.title,
          subjectName: def.subjectName,
          chapterName: def.chapterName,
          status: (row?.status ?? 'not_started') as TaskStatus,
          lamportClock: row?.lamport_clock ?? 0,
          deviceId: row?.device_id ?? '',
          synced: (row?.synced ?? 0) === 1,
        };
      });

      set({ tasks, subjects: computeProgress(tasks) });
    } finally {
      set({ isLoading: false });
    }
  },

  /**
   * Cycle a task's status, persist to SQLite with a new Lamport clock, and
   * enqueue a sync op. The UI updates instantly (offline-first).
   *
   * Order of operations matters:
   *   1. Increment Lamport clock (so this write is ordered after all prior local ops)
   *   2. Update task_states in SQLite with the new clock
   *   3. Enqueue a pending op (engine uses the same clock value)
   *   4. Update Zustand state so the UI re-renders immediately
   */
  updateTaskStatus: async (taskId: string, newStatus: TaskStatus) => {
    const db = getDb();
    const deviceId = getDeviceId();

    // 1. Claim the next Lamport clock value
    const lamportClock = await incrementAndGetLamportClock();

    // 2. Persist to SQLite
    await db.runAsync(
      `UPDATE task_states
       SET status = ?, lamport_clock = ?, device_id = ?, synced = 0
       WHERE task_id = ? AND student_id = ?`,
      [newStatus, lamportClock, deviceId, taskId, STUDENT_ID]
    );

    // 3. Enqueue sync op (the engine will include it in the next POST /api/sync)
    await syncEngine.enqueueOp({
      type: 'TASK_STATUS',
      entityId: taskId,
      payload: {
        taskId,
        status: newStatus,
      },
    });

    // 4. Optimistic store update — instant UI reflect
    const updated = get().tasks.map((t) =>
      t.taskId === taskId
        ? { ...t, status: newStatus, lamportClock, deviceId, synced: false }
        : t
    );
    set({ tasks: updated, subjects: computeProgress(updated) });

    // Background sync (best-effort; failure is fine)
    syncEngine.sync().catch(() => {});
  },

  // Called after a successful sync so the store reflects any remote changes
  refreshAfterSync: async () => {
    await get().loadTasks();
  },
}));
