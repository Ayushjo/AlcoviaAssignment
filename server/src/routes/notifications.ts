import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';

const router = Router();

/**
 * POST /api/notifications/sink
 *
 * Mock notification sink — stands in for "WhatsApp" (or any external delivery
 * channel). Called by the n8n workflow after deduplication. Every call is logged
 * to sink_log so the DevPanel can show that a given session was delivered exactly
 * once even when the same session synced from two devices.
 */
router.post('/sink', (req: Request, res: Response) => {
  const db = getDb();
  const payload = req.body as Record<string, unknown>;
  const sessionId = String(payload.sessionId ?? '');
  const studentId = String(payload.studentId ?? '');

  db.prepare(
    `INSERT INTO sink_log (session_id, student_id, payload, received_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(sessionId, studentId, JSON.stringify(payload));

  console.log(`[sink] Notification delivered for session ${sessionId} — ${JSON.stringify(payload)}`);
  res.json({ ok: true, delivered: true });
});

/**
 * GET /api/notifications/sink-log
 *
 * Returns the last 50 sink deliveries. The DevPanel polls this to show that
 * n8n fired the notification exactly once per successful session.
 */
router.get('/sink-log', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, session_id, student_id, payload, received_at
     FROM sink_log ORDER BY id DESC LIMIT 50`
  ).all();
  res.json(rows);
});

/**
 * POST /api/notifications/reply
 *
 * Two-way reply loop (Extension 2): simulate a student replying "done" or
 * "snooze" to a notification. The action is recorded as a new sync op so it
 * reconciles across devices just like any other task-state change.
 */
router.post('/reply', (req: Request, res: Response) => {
  const db = getDb();
  const { sessionId, studentId, action } = req.body as {
    sessionId: string;
    studentId: string;
    action: 'done' | 'snooze';
  };

  if (!sessionId || !studentId || !action) {
    res.status(400).json({ error: 'sessionId, studentId, and action are required' });
    return;
  }

  db.prepare(
    `INSERT OR IGNORE INTO notification_log (session_id, student_id, payload, fired_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(sessionId, studentId, JSON.stringify({ type: 'reply', action }));

  console.log(`[reply] Received reply action="${action}" for session ${sessionId}`);
  res.json({ ok: true, action, sessionId });
});

export default router;
