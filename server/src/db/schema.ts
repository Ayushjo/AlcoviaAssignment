import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(__dirname, '../../data/alcovia.db');
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  // Ensure data directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function initServerDb(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      target_duration INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      fail_reason TEXT,
      actual_duration INTEGER,
      lamport_clock INTEGER NOT NULL,
      reward_granted INTEGER NOT NULL DEFAULT 0,
      notification_sent INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_states (
      task_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_started',
      lamport_clock INTEGER NOT NULL DEFAULT 0,
      device_id TEXT NOT NULL DEFAULT '',
      deleted_at_clock INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS student_rewards (
      student_id TEXT PRIMARY KEY,
      coins INTEGER NOT NULL DEFAULT 0,
      focus_streak INTEGER NOT NULL DEFAULT 0,
      today_focus_minutes INTEGER NOT NULL DEFAULT 0,
      last_focus_date TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      title TEXT NOT NULL,
      subject_name TEXT NOT NULL,
      chapter_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operation_log (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      op_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      lamport_clock INTEGER NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oplog ON operation_log(device_id, lamport_clock);
    CREATE INDEX IF NOT EXISTS idx_oplog_student ON operation_log(student_id, received_at);
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      fired_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sink_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  console.log('Database initialized at', DB_PATH);
}
