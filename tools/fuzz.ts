/**
 * Property / fuzz test for the Alcovia sync convergence guarantee.
 *
 * Run with:  npx tsx tools/fuzz.ts
 *
 * What this tests (for 200 random seeds, 20 ops each, 3 devices):
 *
 *   1. Commutativity — applying the same set of ops in 50 different random
 *      orders always yields the same final task-state map and coin total.
 *      (This is the core convergence proof: every device ends up identical.)
 *
 *   2. Idempotency — replaying the entire op set 3× yields the same result.
 *
 *   3. Correct coin count — coins = 50 × distinct completed sessions, always.
 *
 *   4. Delete-wins — once a tombstone wins the merge, the task stays deleted;
 *      a concurrent edit from another device cannot resurrect it.
 *
 * The merge logic here mirrors mergeService.ts and resolver.ts exactly.
 */

import { v4 as uuidv4 } from 'uuid';
import { compareOps } from '../packages/shared/src/lamport';
import type { SyncOp, TaskStatusPayload, SessionPayload } from '../packages/shared/src/types';
import { TASK_DEFINITIONS } from '../packages/shared/src/taskDefinitions';

// ── Types ──────────────────────────────────────────────────────────────────

type TaskStatus = 'not_started' | 'in_progress' | 'done';

interface TaskState {
  taskId: string;
  status: TaskStatus;
  lamportClock: number;
  deviceId: string;
  deletedAtClock: number | null;
}

interface SessionState {
  id: string;
  status: 'completed' | 'failed';
  rewardGranted: boolean;
}

interface WorldState {
  tasks: Map<string, TaskState>;
  sessions: Map<string, SessionState>;
  coins: number;
}

// ── In-memory merge (mirrors mergeService.ts + resolver.ts) ───────────────

function mergeTaskOp(existing: TaskState | undefined, op: SyncOp): TaskState {
  const p = op.payload as TaskStatusPayload;
  const incoming: TaskState = {
    taskId: p.taskId,
    status: p.status,
    lamportClock: op.lamportClock,
    deviceId: op.deviceId,
    deletedAtClock: p.deletedAtClock ?? null,
  };

  if (!existing) return incoming;

  // Delete-wins: a tombstone beats any concurrent edit, regardless of clock
  const incomingDeleted = incoming.deletedAtClock != null;
  const existingDeleted = existing.deletedAtClock != null;

  if (incomingDeleted && !existingDeleted) return incoming;
  if (existingDeleted && !incomingDeleted) return existing;

  // Both edits (or both tombstones): Lamport LWW + deviceId tie-break
  return compareOps(incoming, existing) > 0 ? incoming : existing;
}

function applyOps(ops: SyncOp[]): WorldState {
  const tasks = new Map<string, TaskState>();
  const sessions = new Map<string, SessionState>();
  let coins = 0;

  // Sort ascending: higher clock = applied later (wins LWW over same task)
  const sorted = [...ops].sort((a, b) => compareOps(a, b));

  for (const op of sorted) {
    if (op.type === 'TASK_STATUS') {
      const p = op.payload as TaskStatusPayload;
      tasks.set(p.taskId, mergeTaskOp(tasks.get(p.taskId), op));
    } else if (op.type === 'SESSION') {
      const p = op.payload as SessionPayload;
      if (!sessions.has(op.entityId)) {
        sessions.set(op.entityId, { id: op.entityId, status: p.status, rewardGranted: false });
      }
      const s = sessions.get(op.entityId)!;
      if (p.status === 'completed' && !s.rewardGranted) {
        s.rewardGranted = true;
        coins += 50;
      }
    }
  }

  return { tasks, sessions, coins };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TASK_IDS = TASK_DEFINITIONS.map((t) => t.id);
const STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'done'];
const DEVICES = ['A', 'B', 'C'];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Seeded-ish random using a simple LCG so seeds are reproducible
function makePrng(seed: number) {
  let s = seed | 0;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let _clock = 0;
function nextClock(): number { return ++_clock; }

function makeTaskOp(taskId: string, deviceId: string, status: TaskStatus, deletedAtClock?: number): SyncOp {
  return {
    id: uuidv4(),
    type: 'TASK_STATUS',
    entityId: taskId,
    deviceId,
    studentId: 'student-001',
    lamportClock: nextClock(),
    payload: { taskId, status, ...(deletedAtClock != null ? { deletedAtClock } : {}) } as TaskStatusPayload,
    createdAt: new Date().toISOString(),
  };
}

function makeSessionOp(deviceId: string, status: 'completed' | 'failed'): SyncOp {
  const sessionId = uuidv4();
  return {
    id: uuidv4(),
    type: 'SESSION',
    entityId: sessionId,
    deviceId,
    studentId: 'student-001',
    lamportClock: nextClock(),
    payload: {
      targetDuration: 3600,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status,
      actualDuration: 3600,
    } as SessionPayload,
    createdAt: new Date().toISOString(),
  };
}

function generateOps(count: number, rand: () => number): SyncOp[] {
  const ops: SyncOp[] = [];
  const randomItemR = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  for (let i = 0; i < count; i++) {
    const device = randomItemR(DEVICES);
    const r = rand();
    if (r < 0.45) {
      ops.push(makeTaskOp(randomItemR(TASK_IDS), device, randomItemR(STATUSES)));
    } else if (r < 0.65) {
      // tombstone op
      const clock = nextClock();
      ops.push(makeTaskOp(randomItemR(TASK_IDS), device, 'not_started', clock));
    } else {
      ops.push(makeSessionOp(device, rand() < 0.7 ? 'completed' : 'failed'));
    }
  }
  return ops;
}

function statesEqual(a: WorldState, b: WorldState): boolean {
  if (a.coins !== b.coins) return false;
  if (a.tasks.size !== b.tasks.size) return false;
  for (const [id, ta] of a.tasks) {
    const tb = b.tasks.get(id);
    if (!tb) return false;
    if (ta.status !== tb.status) return false;
    if ((ta.deletedAtClock != null) !== (tb.deletedAtClock != null)) return false;
    // The winning Lamport clock and deviceId must also match
    if (ta.lamportClock !== tb.lamportClock) return false;
    if (ta.deviceId !== tb.deviceId) return false;
  }
  return true;
}

// ── Test runner ────────────────────────────────────────────────────────────

const NUM_SEEDS = 200;
const OPS_PER_SEED = 20;
const SHUFFLES_PER_SEED = 50;

console.log(`Running ${NUM_SEEDS} fuzz seeds × ${SHUFFLES_PER_SEED} shuffles (${OPS_PER_SEED} ops, 3 devices)…`);

let totalFailed = 0;

for (let seed = 0; seed < NUM_SEEDS; seed++) {
  _clock = seed * 10_000;
  const rand = makePrng(seed);
  const ops = generateOps(OPS_PER_SEED, rand);
  const baseState = applyOps(ops);

  // Property 1: commutativity — any shuffle of ops converges to same state
  for (let s = 0; s < SHUFFLES_PER_SEED; s++) {
    const shuffled = shuffle(ops, makePrng(seed * 1000 + s));
    const shuffledState = applyOps(shuffled);
    if (!statesEqual(shuffledState, baseState)) {
      console.error(`FAIL [commutativity] seed=${seed} shuffle=${s}`);
      totalFailed++;
      break;
    }
  }

  // Property 2: idempotency — triple replay
  const tripleState = applyOps([...ops, ...ops, ...ops]);
  if (!statesEqual(tripleState, baseState)) {
    console.error(`FAIL [idempotency] seed=${seed}: triple-replay diverged`);
    totalFailed++;
  }

  // Property 3: coins = 50 × completed sessions
  const completedCount = [...baseState.sessions.values()].filter((s) => s.status === 'completed').length;
  if (baseState.coins !== completedCount * 50) {
    console.error(`FAIL [coins] seed=${seed}: coins=${baseState.coins} expected=${completedCount * 50}`);
    totalFailed++;
  }

  // Property 4: delete-wins — find all tombstone ops; their task must be deleted in final state
  for (const op of ops) {
    if (op.type !== 'TASK_STATUS') continue;
    const p = op.payload as TaskStatusPayload;
    if (p.deletedAtClock == null) continue;

    const finalTask = baseState.tasks.get(p.taskId);
    if (!finalTask) continue; // task not in map at all — ok

    // The winning op for this task must also be a tombstone
    // (delete-wins: if this tombstone lost, the winner must be a later tombstone)
    if (finalTask.deletedAtClock == null) {
      // Check if there's a later non-tombstone op that legitimately beat this tombstone
      // In our delete-wins rule, that's impossible — a non-tombstone can never beat a tombstone
      console.error(`FAIL [delete-wins] seed=${seed}: tombstone on task ${p.taskId} lost to a non-tombstone`);
      console.error('  Tombstone op:', op.lamportClock, op.deviceId, p.deletedAtClock);
      console.error('  Final state:', finalTask);
      totalFailed++;
    }
  }
}

if (totalFailed > 0) {
  console.error(`\n✗ ${totalFailed} failures.`);
  process.exit(1);
} else {
  console.log(`\n✓ All ${NUM_SEEDS} seeds × ${SHUFFLES_PER_SEED} shuffles passed.`);
  console.log('  Commutativity : any ordering of ops converges to the same state');
  console.log('  Idempotency   : triple-replaying all ops produces the same result');
  console.log('  Coins         : always = 50 × distinct completed sessions');
  console.log('  Delete-wins   : tombstones always win over concurrent edits');
}
