import { v4 as uuidv4 } from 'uuid';
import { SyncOp, SyncRequest, SyncResponse, compareOps } from '@alcovia/shared';
import {
  getDb,
  getVectorClock,
  updateVectorClock,
  incrementAndGetLamportClock,
} from '../db/client';
import { STUDENT_ID, SERVER_URL, getDeviceId } from '../constants';
import { applyRemoteOps } from './resolver';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success';

export interface SyncResult {
  newOpsReceived: number;
  opsSent: number;
}

class SyncEngine {
  private isSyncing = false;
  private listeners: Array<(status: SyncStatus) => void> = [];

  onStatusChange(cb: (status: SyncStatus) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private emit(status: SyncStatus) {
    this.listeners.forEach((l) => l(status));
  }

  /**
   * Enqueue a local operation into pending_ops and immediately increment the Lamport clock.
   * Called before touching local state so the clock is always ahead of any unsynced change.
   */
  async enqueueOp(
    partial: Pick<SyncOp, 'type' | 'entityId' | 'payload'>
  ): Promise<SyncOp> {
    const db = getDb();
    const deviceId = getDeviceId();
    const lamportClock = await incrementAndGetLamportClock();

    const op: SyncOp = {
      id: uuidv4(),
      type: partial.type,
      entityId: partial.entityId,
      payload: partial.payload,
      deviceId,
      studentId: STUDENT_ID,
      lamportClock,
      createdAt: new Date().toISOString(),
    };

    await db.runAsync(
      `INSERT INTO pending_ops
         (id, type, entity_id, payload, lamport_clock, device_id, student_id, created_at, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        op.id,
        op.type,
        op.entityId,
        JSON.stringify(op.payload),
        op.lamportClock,
        op.deviceId,
        op.studentId,
        op.createdAt,
      ]
    );

    return op;
  }

  /**
   * Push all pending ops to the server and pull back any ops from other devices.
   * Returns null if a sync is already in progress or if the call throws (offline).
   */
  async sync(): Promise<SyncResult | null> {
    if (this.isSyncing) return null;
    this.isSyncing = true;
    this.emit('syncing');

    try {
      const db = getDb();
      const deviceId = getDeviceId();

      // Collect all unsynced ops ordered by Lamport clock
      const rows = await db.getAllAsync<{
        id: string;
        type: string;
        entity_id: string;
        payload: string;
        lamport_clock: number;
        device_id: string;
        student_id: string;
        created_at: string;
      }>(`SELECT * FROM pending_ops WHERE synced = 0 ORDER BY lamport_clock ASC`);

      const ops: SyncOp[] = rows.map((r) => ({
        id: r.id,
        type: r.type as SyncOp['type'],
        entityId: r.entity_id,
        payload: JSON.parse(r.payload),
        lamportClock: r.lamport_clock,
        deviceId: r.device_id,
        studentId: r.student_id,
        createdAt: r.created_at,
      }));

      const vectorClock = await getVectorClock();

      const request: SyncRequest = {
        studentId: STUDENT_ID,
        deviceId,
        vectorClock,
        ops,
      };

      const response = await fetch(`${SERVER_URL}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Sync failed with status ${response.status}`);
      }

      const data: SyncResponse = await response.json();

      // Apply ops from other devices
      if (data.newOps.length > 0) {
        await applyRemoteOps(data.newOps);
      }

      // Overwrite local rewards with authoritative server state
      await db.runAsync(
        `UPDATE student_rewards
         SET coins = ?, focus_streak = ?, today_focus_minutes = ?,
             last_focus_date = ?, last_synced_at = ?
         WHERE student_id = ?`,
        [
          data.rewards.coins,
          data.rewards.focusStreak,
          data.rewards.todayFocusMinutes,
          data.rewards.lastFocusDate ?? null,
          new Date().toISOString(),
          STUDENT_ID,
        ]
      );

      // Reconcile canonical server task states into local DB.
      // Merge rule: delete-wins first, then Lamport LWW — mirrors mergeService.ts.
      for (const serverTask of data.tasks) {
        await db.runAsync(
          `INSERT INTO task_states
             (task_id, student_id, status, lamport_clock, device_id, deleted_at_clock, synced)
           VALUES (?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(task_id, student_id) DO UPDATE SET
             status = CASE
               WHEN excluded.deleted_at_clock IS NOT NULL AND task_states.deleted_at_clock IS NULL THEN excluded.status
               WHEN task_states.deleted_at_clock IS NOT NULL AND excluded.deleted_at_clock IS NULL THEN task_states.status
               WHEN excluded.lamport_clock > task_states.lamport_clock THEN excluded.status
               WHEN excluded.lamport_clock = task_states.lamport_clock
                AND excluded.device_id > task_states.device_id THEN excluded.status
               ELSE task_states.status
             END,
             lamport_clock = CASE
               WHEN excluded.deleted_at_clock IS NOT NULL AND task_states.deleted_at_clock IS NULL THEN excluded.lamport_clock
               WHEN task_states.deleted_at_clock IS NOT NULL AND excluded.deleted_at_clock IS NULL THEN task_states.lamport_clock
               WHEN excluded.lamport_clock > task_states.lamport_clock THEN excluded.lamport_clock
               WHEN excluded.lamport_clock = task_states.lamport_clock
                AND excluded.device_id > task_states.device_id THEN excluded.lamport_clock
               ELSE task_states.lamport_clock
             END,
             device_id = CASE
               WHEN excluded.deleted_at_clock IS NOT NULL AND task_states.deleted_at_clock IS NULL THEN excluded.device_id
               WHEN task_states.deleted_at_clock IS NOT NULL AND excluded.deleted_at_clock IS NULL THEN task_states.device_id
               WHEN excluded.lamport_clock > task_states.lamport_clock THEN excluded.device_id
               WHEN excluded.lamport_clock = task_states.lamport_clock
                AND excluded.device_id > task_states.device_id THEN excluded.device_id
               ELSE task_states.device_id
             END,
             deleted_at_clock = CASE
               WHEN excluded.deleted_at_clock IS NOT NULL AND task_states.deleted_at_clock IS NULL THEN excluded.deleted_at_clock
               WHEN task_states.deleted_at_clock IS NOT NULL AND excluded.deleted_at_clock IS NULL THEN task_states.deleted_at_clock
               WHEN excluded.lamport_clock > task_states.lamport_clock THEN excluded.deleted_at_clock
               WHEN excluded.lamport_clock = task_states.lamport_clock
                AND excluded.device_id > task_states.device_id THEN excluded.deleted_at_clock
               ELSE task_states.deleted_at_clock
             END,
             synced = 1`,
          [
            serverTask.taskId,
            serverTask.studentId,
            serverTask.status,
            serverTask.lamportClock,
            serverTask.deviceId,
            serverTask.deletedAtClock ?? null,
          ]
        );
      }

      // Mark all sent ops as synced
      if (ops.length > 0) {
        const sentIds = ops.map((o) => o.id);
        const placeholders = sentIds.map(() => '?').join(',');
        await db.runAsync(
          `UPDATE pending_ops SET synced = 1 WHERE id IN (${placeholders})`,
          sentIds
        );
        // Flip synced flag on sessions that were sent
        await db.runAsync(
          `UPDATE sessions SET synced = 1
           WHERE id IN (
             SELECT entity_id FROM pending_ops
             WHERE id IN (${placeholders}) AND type = 'SESSION'
           )`,
          sentIds
        );
      }

      // Update our own entry in the vector clock with the max Lamport we just sent
      if (ops.length > 0) {
        const maxSent = Math.max(...ops.map((o) => o.lamportClock));
        await updateVectorClock(deviceId, maxSent);
      }

      this.emit('success');
      return { newOpsReceived: data.newOps.length, opsSent: ops.length };
    } catch (err) {
      this.emit('error');
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  async getPendingOpsCount(): Promise<number> {
    const db = getDb();
    const row = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM pending_ops WHERE synced = 0`
    );
    return row?.count ?? 0;
  }

  get syncing(): boolean {
    return this.isSyncing;
  }
}

// Singleton — shared across the entire app process
export const syncEngine = new SyncEngine();
