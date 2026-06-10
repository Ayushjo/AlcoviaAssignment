import { Router, Request, Response } from 'express';
import type { SyncRequest, SyncResponse } from '@alcovia/shared';
import { TASK_DEFINITIONS } from '@alcovia/shared';
import {
  processIncomingOps,
  getNewOpsForDevice,
  getCanonicalTaskStates,
} from '../services/mergeService';
import { processRewards, getRewardState } from '../services/rewardService';
import { fireSessionNotificationIfNeeded } from '../services/n8nService';
import { getDb } from '../db/schema';

const router = Router();

/**
 * POST /api/sync
 *
 * The single sync endpoint. Each client call:
 *   1. Pushes its pending ops → server merges them (idempotent, Lamport LWW)
 *   2. Rewards are computed for any newly completed sessions (idempotent transaction)
 *   3. n8n notifications fire async for freshly rewarded sessions (atomic claim guard)
 *   4. Server returns ops the requesting device hasn't seen + canonical task state + rewards
 *
 * The client replays the same ops on retry — the server silently ignores duplicates via
 * operation_log's primary key constraint.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as SyncRequest;
    const { studentId, deviceId, vectorClock, ops } = body;

    if (!studentId || !deviceId) {
      res.status(400).json({ error: 'studentId and deviceId are required' });
      return;
    }

    // 1. Merge incoming ops (synchronous, transactional)
    if (Array.isArray(ops) && ops.length > 0) {
      processIncomingOps(ops);
    }

    // 2. Grant rewards for any newly completed sessions (synchronous, atomic)
    const { newSuccessSessionIds } = processRewards(studentId);

    // 3. Read the authoritative reward state after grants
    const rewards = getRewardState(studentId);

    // 4. Fire n8n notifications asynchronously — don't block the sync response.
    //    We attempt every session that is rewarded but not yet notified (not just
    //    new ones). This makes notifications retryable: if a webhook call failed and
    //    rolled back notification_sent to 0, the next sync will pick it up again.
    //    Exactly-once is preserved by the atomic claim in fireSessionNotificationIfNeeded
    //    (server layer) and by static-data dedup inside the n8n workflow (n8n layer).
    const pendingNotifications = getDb().prepare(`
      SELECT id FROM sessions
      WHERE student_id = ? AND status = 'completed'
        AND reward_granted = 1 AND notification_sent = 0
    `).all(studentId) as Array<{ id: string }>;

    const toNotify = new Set([...newSuccessSessionIds, ...pendingNotifications.map((r) => r.id)]);
    for (const sessionId of toNotify) {
      fireSessionNotificationIfNeeded(sessionId, studentId, {
        coins: rewards.coins,
        focusStreak: rewards.focusStreak,
      }).catch((err: unknown) =>
        console.error(`[sync] n8n notification failed for ${sessionId}:`, err)
      );
    }

    // 5. Compute what this device hasn't seen yet
    const newOps = getNewOpsForDevice(studentId, deviceId, vectorClock ?? {});

    // 6. Return canonical task states so the client can reconcile
    const tasks = getCanonicalTaskStates(studentId);

    const response: SyncResponse = {
      newOps,
      rewards,
      tasks,
      taskDefinitions: TASK_DEFINITIONS,
    };

    res.json(response);
  } catch (err) {
    console.error('[sync] Unhandled error:', err);
    res.status(500).json({ error: 'Sync failed', detail: String(err) });
  }
});

export default router;
