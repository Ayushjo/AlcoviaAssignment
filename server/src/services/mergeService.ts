import type { SyncOp, TaskStatusPayload, SessionPayload, TaskState } from '@alcovia/shared';
import { filterUnseen } from '@alcovia/shared';
import { getDb } from '../db/schema';

/**
 * Process a batch of incoming ops from a client device.
 * Uses ON CONFLICT IGNORE on operation IDs so replaying the same batch is safe.
 * All task-state merges use Lamport LWW in SQL — same merge function runs on every device,
 * ensuring all devices converge to the same canonical state.
 */
export function processIncomingOps(ops: SyncOp[]): void {
  const db = getDb();

  const insertOp = db.prepare(`
    INSERT OR IGNORE INTO operation_log
      (id, device_id, student_id, op_type, entity_id, lamport_clock, payload, received_at)
    VALUES (@id, @deviceId, @studentId, @opType, @entityId, @lamportClock, @payload, @receivedAt)
  `);

  const processAll = db.transaction((batch: SyncOp[]) => {
    for (const op of batch) {
      const inserted = insertOp.run({
        id: op.id,
        deviceId: op.deviceId,
        studentId: op.studentId,
        opType: op.type,
        entityId: op.entityId,
        lamportClock: op.lamportClock,
        payload: JSON.stringify(op.payload),
        receivedAt: new Date().toISOString(),
      });

      // Only apply the op if it wasn't a duplicate (changes === 0 means we already have it)
      if (inserted.changes === 0) continue;

      if (op.type === 'SESSION') {
        applySessionOp(op);
      } else if (op.type === 'TASK_STATUS') {
        applyTaskStatusOp(op);
      }
    }
  });

  processAll(ops);
}

function applySessionOp(op: SyncOp): void {
  const db = getDb();
  const p = op.payload as SessionPayload;

  // Sessions are immutable — INSERT OR IGNORE means replays never double-count
  db.prepare(`
    INSERT OR IGNORE INTO sessions
      (id, student_id, device_id, target_duration, started_at, ended_at,
       status, fail_reason, actual_duration, lamport_clock,
       reward_granted, notification_sent, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
  `).run(
    op.entityId,
    op.studentId,
    op.deviceId,
    p.targetDuration,
    p.startedAt,
    p.endedAt,
    p.status,
    p.failReason ?? null,
    p.actualDuration,
    op.lamportClock,
    new Date().toISOString()
  );
}

function applyTaskStatusOp(op: SyncOp): void {
  const db = getDb();
  const p = op.payload as TaskStatusPayload;

  // Lamport LWW encoded directly in SQL so it runs atomically and is deterministic.
  // Higher clock wins. On a tie, the lexicographically higher deviceId wins.
  // Both conditions are checked in parallel in all CASE expressions so they stay in sync.
  db.prepare(`
    INSERT INTO task_states
      (task_id, student_id, status, lamport_clock, device_id, deleted_at_clock, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(task_id, student_id) DO UPDATE SET
      status = CASE
        WHEN excluded.lamport_clock > task_states.lamport_clock THEN excluded.status
        WHEN excluded.lamport_clock = task_states.lamport_clock
         AND excluded.device_id > task_states.device_id   THEN excluded.status
        ELSE task_states.status
      END,
      lamport_clock = CASE
        WHEN excluded.lamport_clock > task_states.lamport_clock THEN excluded.lamport_clock
        WHEN excluded.lamport_clock = task_states.lamport_clock
         AND excluded.device_id > task_states.device_id   THEN excluded.lamport_clock
        ELSE task_states.lamport_clock
      END,
      device_id = CASE
        WHEN excluded.lamport_clock > task_states.lamport_clock THEN excluded.device_id
        WHEN excluded.lamport_clock = task_states.lamport_clock
         AND excluded.device_id > task_states.device_id   THEN excluded.device_id
        ELSE task_states.device_id
      END,
      deleted_at_clock = CASE
        WHEN excluded.lamport_clock > task_states.lamport_clock THEN excluded.deleted_at_clock
        WHEN excluded.lamport_clock = task_states.lamport_clock
         AND excluded.device_id > task_states.device_id   THEN excluded.deleted_at_clock
        ELSE task_states.deleted_at_clock
      END,
      updated_at = datetime('now')
  `).run(
    p.taskId,
    op.studentId,
    p.status,
    op.lamportClock,
    op.deviceId,
    p.deletedAtClock ?? null
  );
}

/**
 * Return all ops from the operation_log that the requesting device has not yet seen,
 * based on its submitted vector clock.
 */
export function getNewOpsForDevice(
  studentId: string,
  requestingDeviceId: string,
  vectorClock: Record<string, number>
): SyncOp[] {
  const db = getDb();

  // Fetch all ops from OTHER devices for this student
  const rows = db.prepare(`
    SELECT id, device_id, student_id, op_type, entity_id, lamport_clock, payload, received_at
    FROM operation_log
    WHERE student_id = ? AND device_id != ?
    ORDER BY lamport_clock ASC
  `).all(studentId, requestingDeviceId) as Array<{
    id: string;
    device_id: string;
    student_id: string;
    op_type: string;
    entity_id: string;
    lamport_clock: number;
    payload: string;
    received_at: string;
  }>;

  const allOps: SyncOp[] = rows.map((r) => ({
    id: r.id,
    type: r.op_type as SyncOp['type'],
    entityId: r.entity_id,
    deviceId: r.device_id,
    studentId: r.student_id,
    lamportClock: r.lamport_clock,
    payload: JSON.parse(r.payload),
    createdAt: r.received_at,
  }));

  // filterUnseen: keep only ops whose Lamport > vectorClock[deviceId]
  return filterUnseen(allOps, vectorClock);
}

/**
 * Return the canonical (post-merge) task state for all tasks belonging to a student.
 * This is authoritative — clients reconcile against this after every sync.
 */
export function getCanonicalTaskStates(studentId: string): TaskState[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT task_id, student_id, status, lamport_clock, device_id, deleted_at_clock
    FROM task_states WHERE student_id = ?
  `).all(studentId) as Array<{
    task_id: string;
    student_id: string;
    status: string;
    lamport_clock: number;
    device_id: string;
    deleted_at_clock: number | null;
  }>;

  return rows.map((r) => ({
    taskId: r.task_id,
    studentId: r.student_id,
    status: r.status as TaskState['status'],
    lamportClock: r.lamport_clock,
    deviceId: r.device_id,
    deletedAtClock: r.deleted_at_clock,
  }));
}
