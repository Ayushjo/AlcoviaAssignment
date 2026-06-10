import * as SQLite from 'expo-sqlite';
import { STUDENT_ID, getDeviceId } from '../constants';
import { TASK_DEFINITIONS } from '@alcovia/shared';
import { CLIENT_SCHEMA_SQL } from './schema';

let _db: SQLite.SQLiteDatabase | null = null;

export function getDb(): SQLite.SQLiteDatabase {
  if (!_db) throw new Error('DB not initialised — call initDb() first');
  return _db;
}

export async function initDb(): Promise<void> {
  const deviceId = getDeviceId();
  // Use openDatabaseAsync so the WASM worker handshake runs on the event loop
  // instead of a blocking spin-loop (Atomics.pause busy-wait) that would
  // deadlock on the main browser thread and throw "Sync operation timeout".
  _db = await SQLite.openDatabaseAsync(`alcovia-device-${deviceId}.db`);
  const db = _db;

  // Create all tables
  await db.execAsync(CLIENT_SCHEMA_SQL);

  // Seed device identity if first run
  await db.runAsync(
    `INSERT OR IGNORE INTO device_meta (key, value) VALUES (?, ?), (?, ?)`,
    ['deviceId', deviceId, 'lamportCounter', '0']
  );

  // Seed initial rewards row for this student
  await db.runAsync(`INSERT OR IGNORE INTO student_rewards (student_id) VALUES (?)`, [STUDENT_ID]);

  // Bootstrap all 27 task states as 'not_started' if not already present
  for (const task of TASK_DEFINITIONS) {
    await db.runAsync(
      `INSERT OR IGNORE INTO task_states
         (task_id, student_id, status, lamport_clock, device_id, synced)
       VALUES (?, ?, 'not_started', 0, ?, 0)`,
      [task.id, STUDENT_ID, deviceId]
    );
  }
}

export async function getLamportClock(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM device_meta WHERE key = 'lamportCounter'`
  );
  return row ? parseInt(row.value, 10) : 0;
}

export async function incrementAndGetLamportClock(): Promise<number> {
  const db = getDb();
  const current = await getLamportClock();
  const next = current + 1;
  await db.runAsync(`UPDATE device_meta SET value = ? WHERE key = 'lamportCounter'`, [
    String(next),
  ]);
  return next;
}

/**
 * Lamport receive rule: pull the local counter up to at least `received`.
 * Called after applying remote ops so any subsequent local edit gets a clock
 * higher than everything this device has observed — i.e. genuine causal
 * "last write wins", not just "whoever did more local ops".
 */
export async function bumpLamportTo(received: number): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `UPDATE device_meta SET value = ? WHERE key = 'lamportCounter' AND CAST(value AS INTEGER) < ?`,
    [String(received), received]
  );
}

export async function getVectorClock(): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db.getAllAsync<{ device_id: string; max_lamport_seen: number }>(
    `SELECT device_id, max_lamport_seen FROM vector_clock`
  );
  const vc: Record<string, number> = {};
  for (const row of rows) {
    vc[row.device_id] = row.max_lamport_seen;
  }
  return vc;
}

export async function updateVectorClock(deviceId: string, lamport: number): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT INTO vector_clock (device_id, max_lamport_seen) VALUES (?, ?)
     ON CONFLICT(device_id) DO UPDATE SET max_lamport_seen = MAX(max_lamport_seen, excluded.max_lamport_seen)`,
    [deviceId, lamport]
  );
}
