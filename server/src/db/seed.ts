import { TASK_DEFINITIONS } from '@alcovia/shared';
import { getDb } from './schema';

const STUDENT_ID = 'student-001';

export function seedDatabase(): void {
  const db = getDb();

  // Seed task definitions (idempotent — INSERT OR IGNORE)
  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO tasks (id, subject_id, chapter_id, title, subject_name, chapter_name)
    VALUES (@id, @subjectId, @chapterId, @title, @subjectName, @chapterName)
  `);

  const seedTasks = db.transaction(() => {
    for (const task of TASK_DEFINITIONS) {
      insertTask.run(task);
    }
  });
  seedTasks();

  // Seed initial task_states for the student (all not_started)
  const insertTaskState = db.prepare(`
    INSERT OR IGNORE INTO task_states (task_id, student_id, status, lamport_clock, device_id, updated_at)
    VALUES (?, ?, 'not_started', 0, 'server', datetime('now'))
  `);

  const seedTaskStates = db.transaction(() => {
    for (const task of TASK_DEFINITIONS) {
      insertTaskState.run(task.id, STUDENT_ID);
    }
  });
  seedTaskStates();

  // Seed initial reward row for the student
  db.prepare(`
    INSERT OR IGNORE INTO student_rewards (student_id, updated_at)
    VALUES (?, datetime('now'))
  `).run(STUDENT_ID);

  console.log(`Seeded ${TASK_DEFINITIONS.length} tasks for student ${STUDENT_ID}`);
}
