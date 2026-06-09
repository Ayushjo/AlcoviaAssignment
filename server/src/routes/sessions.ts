import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';

const router = Router();

/**
 * PATCH /api/sessions/:sessionId/mark-notified
 *
 * Called by the n8n workflow after successfully sending the notification.
 * This is the second dedup layer: even if the server's notification_sent flag was
 * already set (Layer 1), this endpoint is safe to call again (idempotent UPDATE).
 */
router.patch('/:sessionId/mark-notified', (req: Request, res: Response) => {
  const db = getDb();
  const { sessionId } = req.params;

  db.prepare(
    `UPDATE sessions SET notification_sent = 1 WHERE id = ?`
  ).run(sessionId);

  res.json({ ok: true, sessionId });
});

/**
 * GET /api/sessions/notification-log
 *
 * Returns the last 50 notification events — shown in the dev panel to prove
 * exactly-once delivery even when the same session syncs from both devices.
 */
router.get('/notification-log', (_req: Request, res: Response) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, session_id, student_id, payload, fired_at
    FROM notification_log
    ORDER BY fired_at DESC
    LIMIT 50
  `).all();

  res.json({ logs: rows });
});

/**
 * GET /api/sessions?studentId=xxx
 *
 * Full session list for a student — useful for the dev panel debug view.
 */
router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const { studentId } = req.query;

  if (!studentId || typeof studentId !== 'string') {
    res.status(400).json({ error: 'studentId query param required' });
    return;
  }

  const sessions = db.prepare(`
    SELECT id, student_id, device_id, target_duration, started_at, ended_at,
           status, fail_reason, actual_duration, lamport_clock,
           reward_granted, notification_sent, received_at
    FROM sessions
    WHERE student_id = ?
    ORDER BY started_at DESC
  `).all(studentId);

  res.json({ sessions });
});

export default router;
