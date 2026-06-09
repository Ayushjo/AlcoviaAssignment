export const CLIENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    target_duration INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    fail_reason TEXT,
    actual_duration INTEGER,
    lamport_clock INTEGER NOT NULL DEFAULT 0,
    synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS task_states (
    task_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started',
    lamport_clock INTEGER NOT NULL DEFAULT 0,
    device_id TEXT NOT NULL,
    deleted_at_clock INTEGER,
    synced INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS student_rewards (
    student_id TEXT PRIMARY KEY,
    coins INTEGER NOT NULL DEFAULT 0,
    focus_streak INTEGER NOT NULL DEFAULT 0,
    today_focus_minutes INTEGER NOT NULL DEFAULT 0,
    last_focus_date TEXT,
    last_synced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS vector_clock (
    device_id TEXT PRIMARY KEY,
    max_lamport_seen INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS pending_ops (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    lamport_clock INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_pending_ops_synced ON pending_ops(synced, created_at);
  CREATE TABLE IF NOT EXISTS device_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;
