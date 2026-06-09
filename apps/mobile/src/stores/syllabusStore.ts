import { create } from 'zustand';
import { TASK_DEFINITIONS } from '@alcovia/shared';
import { getDb } from '../db/client';
import { STUDENT_ID } from '../constants';
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
}

interface SyllabusStore {
  tasks: TaskRow[];
  subjects: SubjectProgress[];
  isLoading: boolean;

  loadTasks: () => Promise<void>;
  setTaskStatus: (taskId: string, status: TaskStatus) => void;
}

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
      };
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
            subject.chapters.reduce((sum, c) => sum + c.percent, 0) /
              subject.chapters.length
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
      }>(
        `SELECT task_id, status, lamport_clock, device_id
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
        };
      });

      set({ tasks, subjects: computeProgress(tasks) });
    } finally {
      set({ isLoading: false });
    }
  },

  setTaskStatus: (taskId, status) => {
    const updated = get().tasks.map((t) =>
      t.taskId === taskId ? { ...t, status } : t
    );
    set({ tasks: updated, subjects: computeProgress(updated) });
  },
}));
