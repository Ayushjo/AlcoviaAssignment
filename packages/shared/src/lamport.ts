import type { SyncOp, VectorClock } from './types';

/** Increment the local Lamport clock before a local operation */
export function incrementClock(current: number): number {
  return current + 1;
}

/** Merge a received clock into the local clock (Lamport receive rule) */
export function mergeClock(local: number, received: number): number {
  return Math.max(local, received) + 1;
}

/**
 * Compare two operations for ordering.
 * Returns positive if a > b (a happened later), negative if a < b.
 * Higher Lamport clock wins; ties broken by lexicographically higher deviceId.
 */
export function compareOps(
  a: { lamportClock: number; deviceId: string },
  b: { lamportClock: number; deviceId: string }
): number {
  if (a.lamportClock !== b.lamportClock) {
    return a.lamportClock - b.lamportClock;
  }
  // Deterministic tie-break: higher deviceId string wins
  return a.deviceId > b.deviceId ? 1 : -1;
}

/**
 * Given two conflicting task state ops, return the winner.
 * The loser's edit is silently discarded — both devices compute the same winner.
 */
export function resolveTaskConflict(
  a: { lamportClock: number; deviceId: string; status: string },
  b: { lamportClock: number; deviceId: string; status: string }
): typeof a {
  return compareOps(a, b) >= 0 ? a : b;
}

/**
 * Update a local vector clock after receiving ops from a remote device.
 * Merges the remote device's lamport into our record.
 */
export function updateVectorClock(
  local: VectorClock,
  remoteDeviceId: string,
  remoteLamport: number
): VectorClock {
  return {
    ...local,
    [remoteDeviceId]: Math.max(local[remoteDeviceId] ?? 0, remoteLamport),
  };
}

/**
 * Filter ops we haven't seen yet from a given device, based on our vector clock.
 */
export function filterUnseen(ops: SyncOp[], vectorClock: VectorClock): SyncOp[] {
  return ops.filter((op) => op.lamportClock > (vectorClock[op.deviceId] ?? 0));
}
