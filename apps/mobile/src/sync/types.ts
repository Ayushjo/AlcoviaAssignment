// Re-export all sync-related types from the shared package for convenient local imports
export type {
  SyncOp,
  SyncOpType,
  SyncRequest,
  SyncResponse,
  VectorClock,
  TaskState,
  TaskDefinition,
  RewardState,
  SessionPayload,
  TaskStatusPayload,
  TaskStatus,
  SessionStatus,
  FailReason,
  ChapterProgress,
  SubjectProgress,
} from '@alcovia/shared';
