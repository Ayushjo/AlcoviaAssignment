import { SyncOp, TaskStatusPayload, SessionPayload, compareOps } from '@alcovia/shared';
import { getDb, updateVectorClock, bumpLamportTo } from '../db/client';

/**
 * Apply a list of remote ops received from the server to the local SQLite database.
 * Ops are sorted by Lamport clock ascending before application so causal order is respected.
 * All writes are idempotent — replaying the same ops produces the same state.
 */
export async function applyRemoteOps(ops: SyncOp[]): Promise<void> {
  if (ops.length === 0) return;
  const sorted = [...ops].sort((a, b) => compareOps(a, b));
  for (const op of sorted) {
    await applyOp(op);
    await updateVectorClock(op.deviceId, op.lamportClock);
  }
  // Lamport receive rule: advance our clock past the highest we just observed so
  // any subsequent local edit is causally after everything we've seen.
  const maxReceived = Math.max(...ops.map((o) => o.lamportClock));
  await bumpLamportTo(maxReceived);
}

async function applyOp(op: SyncOp): Promise<void> {
  if (op.type === 'SESSION') {
    await applySessionOp(op);
  } else if (op.type === 'TASK_STATUS') {
    await applyTaskStatusOp(op);
  }
}

async function applySessionOp(op: SyncOp): Promise<void> {
  const db = getDb();
  const p = op.payload as SessionPayload;

  // Sessions are immutable once written — INSERT OR IGNORE means replays are safe
  await db.runAsync(
    `INSERT OR IGNORE INTO sessions
       (id, student_id, device_id, target_duration, started_at, ended_at,
        status, fail_reason, actual_duration, lamport_clock, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
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
    ]
  );
}

async function applyTaskStatusOp(op: SyncOp): Promise<void> {
  const db = getDb();
  const p = op.payload as TaskStatusPayload;

  const existing = await db.getFirstAsync<{
    lamport_clock: number;
    device_id: string;
  }>(
    `SELECT lamport_clock, device_id FROM task_states WHERE task_id = ? AND student_id = ?`,
    [p.taskId, op.studentId]
  );

  if (!existing) {
    await db.runAsync(
      `INSERT INTO task_states (task_id, student_id, status, lamport_clock, device_id, deleted_at_clock, synced)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [p.taskId, op.studentId, p.status, op.lamportClock, op.deviceId, p.deletedAtClock ?? null]
    );
    return;
  }

  // Merge rule: delete-wins, then Lamport LWW (same logic as server mergeService)
  const incoming = {
    lamportClock: op.lamportClock,
    deviceId: op.deviceId,
    status: p.status,
    deletedAtClock: p.deletedAtClock ?? null,
  };
  const current = {
    lamportClock: existing.lamport_clock,
    deviceId: existing.device_id,
    status: '' as string,
    deletedAtClock: existing.deleted_at_clock,
  };

  const incomingWins =
    (incoming.deletedAtClock != null && current.deletedAtClock == null) ||
    (current.deletedAtClock == null && incoming.deletedAtClock == null && compareOps(incoming, current) > 0);

  if (incomingWins) {
    await db.runAsync(
      `UPDATE task_states
       SET status = ?, lamport_clock = ?, device_id = ?, deleted_at_clock = ?, synced = 1
       WHERE task_id = ? AND student_id = ?`,
      [p.status, op.lamportClock, op.deviceId, p.deletedAtClock ?? null, p.taskId, op.studentId]
    );
  }
  // If current wins, discard incoming op — both devices compute the same winner
}
