import express from 'express';
import cors from 'cors';
import { TASK_DEFINITIONS } from '@alcovia/shared';
import { initServerDb } from './db/schema';
import { seedDatabase } from './db/seed';

const app = express();

app.use(cors());
app.use(express.json());

// Initialize database synchronously before accepting requests
initServerDb();
seedDatabase();

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: TASK_DEFINITIONS });
});

// Routes will be mounted here in later phases
// app.use('/api/sync', syncRouter);
// app.use('/api/sessions', sessionsRouter);

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
