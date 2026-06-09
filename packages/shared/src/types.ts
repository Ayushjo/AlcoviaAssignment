// ── Task & Session status types ──────────────────────────────────────────────
export type TaskStatus = 'not_started' | 'in_progress' | 'done';
export type SessionStatus = 'active' | 'completed' | 'failed';
export type FailReason = 'give_up' | 'app_switch';
export type SyncOpType = 'SESSION' | 'TASK_STATUS';

// ── Operation payloads ───────────────────────────────────────────────────────
export interface SessionPayload {
  targetDuration: number; // seconds
  startedAt: string; // ISO 8601
  endedAt: string; // ISO 8601
  status: 'completed' | 'failed';
  failReason?: FailReason;
  actualDuration: number; // seconds
}

export interface TaskStatusPayload {
  taskId: string;
  status: TaskStatus;
  deletedAtClock?: number; // Lamport clock of deletion (tombstone)
}

// ── Core sync operation ──────────────────────────────────────────────────────
export interface SyncOp {
  id: string; // UUID — stable identifier for this operation
  type: SyncOpType;
  entityId: string; // sessionId or taskId
  deviceId: string;
  studentId: string;
  lamportClock: number;
  payload: SessionPayload | TaskStatusPayload;
  createdAt: string; // ISO 8601
}

// ── Vector clock ─────────────────────────────────────────────────────────────
// Maps deviceId → highest Lamport clock seen from that device
export type VectorClock = Record<string, number>;

// ── Sync protocol ────────────────────────────────────────────────────────────
export interface SyncRequest {
  studentId: string;
  deviceId: string;
  vectorClock: VectorClock;
  ops: SyncOp[];
}

export interface RewardState {
  coins: number;
  focusStreak: number;
  todayFocusMinutes: number; // total minutes today
  lastFocusDate: string | null; // 'YYYY-MM-DD'
}

export interface TaskState {
  taskId: string;
  studentId: string;
  status: TaskStatus;
  lamportClock: number;
  deviceId: string;
  deletedAtClock: number | null;
}

export interface TaskDefinition {
  id: string;
  subjectId: string;
  chapterId: string;
  title: string;
  subjectName: string;
  chapterName: string;
}

export interface SyncResponse {
  newOps: SyncOp[];
  rewards: RewardState;
  tasks: TaskState[];
  taskDefinitions: TaskDefinition[]; // full seeded task list
}

// ── Domain models ─────────────────────────────────────────────────────────────
export interface Session {
  id: string;
  studentId: string;
  deviceId: string;
  targetDuration: number; // seconds
  startedAt: string;
  endedAt?: string;
  status: SessionStatus;
  failReason?: FailReason;
  actualDuration?: number;
  lamportClock: number;
  synced: boolean;
}

export interface ChapterProgress {
  chapterId: string;
  chapterName: string;
  totalTasks: number;
  completedTasks: number;
  percent: number; // 0–100
}

export interface SubjectProgress {
  subjectId: string;
  subjectName: string;
  chapters: ChapterProgress[];
  percent: number; // average of chapter percents
}
