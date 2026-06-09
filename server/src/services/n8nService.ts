import { getDb } from '../db/schema';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? '';

export interface NotificationPayload {
  sessionId: string;
  studentId: string;
  streak: number;
  coins: number;
  message: string;
  firedAt: string;
}

/**
 * Fire the n8n notification webhook for a successful focus session.
 *
 * Idempotency — two layers:
 *
 *   Layer 1 (server, this function):
 *     An atomic UPDATE ... WHERE notification_sent = 0 acts as a claim.
 *     If two sync requests deliver the same sessionId concurrently, SQLite
 *     serialises the transaction and only the first UPDATE has changes > 0.
 *     The second call bails out before touching the network.
 *
 *   Layer 2 (n8n workflow):
 *     The n8n workflow also checks $getWorkflowStaticData('global') for the
 *     sessionId before acting. This catches the edge case where the server
 *     crashes after firing the webhook but before persisting notification_sent = 1,
 *     meaning the server retries — but n8n still deduplicates.
 *
 * If the HTTP call fails, notification_sent is rolled back to 0 so the next
 * sync attempt can retry.
 */
export async function fireSessionNotificationIfNeeded(
  sessionId: string,
  studentId: string,
  rewards: { coins: number; focusStreak: number }
): Promise<void> {
  if (!N8N_WEBHOOK_URL) {
    console.log(
      `[n8n] N8N_WEBHOOK_URL not configured — skipping notification for session ${sessionId}`
    );
    return;
  }

  const db = getDb();

  // Atomic claim: flip notification_sent only if the session is completed and not yet notified
  const claim = db.prepare(`
    UPDATE sessions
    SET notification_sent = 1
    WHERE id = ? AND status = 'completed' AND notification_sent = 0
  `).run(sessionId);

  if (claim.changes === 0) {
    console.log(`[n8n] Notification already sent (or session not completed) for ${sessionId}`);
    return;
  }

  const payload: NotificationPayload = {
    sessionId,
    studentId,
    streak: rewards.focusStreak,
    coins: rewards.coins,
    message: `Streak now ${rewards.focusStreak} ${rewards.focusStreak === 1 ? 'day' : 'days'}, +50 coins.`,
    firedAt: new Date().toISOString(),
  };

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Log notification regardless of n8n response code so dev panel can show it
    db.prepare(`
      INSERT INTO notification_log (session_id, student_id, payload, fired_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(sessionId, studentId, JSON.stringify(payload));

    console.log(
      `[n8n] Notification fired for session ${sessionId} — n8n responded ${response.status}`
    );
  } catch (err) {
    // Roll back the claim so the next sync can retry
    db.prepare(`UPDATE sessions SET notification_sent = 0 WHERE id = ?`).run(sessionId);
    console.error(`[n8n] Webhook call failed for session ${sessionId}:`, err);
  }
}
