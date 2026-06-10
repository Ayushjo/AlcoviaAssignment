# Decisions

## 1. Data / sync model

**Operation log + Lamport clocks (not snapshot diffing)**

Every mutation — session completion, task status change, task deletion — is written to a local `pending_ops` table before touching local state. Each op carries:

- A **UUID** (`id`) that makes it globally unique and safe to replay.
- A **Lamport clock** (`lamportClock`) — a logical counter, not a wall-clock timestamp.
- The originating `deviceId`.

The server maintains a single `operation_log` table keyed on `(id)`. Any op arriving twice is silently ignored via `INSERT OR IGNORE`.

**Vector clock for dedup, not causality**

Each device keeps a `vector_clock` table: `{deviceId → maxLamportSeen}`. On sync:
- The client sends all unsynced ops + its current vector clock.
- The server returns all ops from *other* devices whose `lamportClock > vectorClock[deviceId]`.

This means the client never receives the same op twice. The vector clock doesn't enforce causality — it's purely an efficiency filter. Causality is enforced by applying ops sorted ascending by Lamport clock + deviceId tie-break.

**Lamport receive rule**

When a device applies remote ops, it bumps its local Lamport counter to `max(local, maxReceivedLamport)`. This ensures any subsequent local edit gets a clock strictly higher than everything the device has observed, so "last write wins" is genuinely causal.

---

## 2. Conflict resolution

### Task status conflicts (same task edited offline on two devices)

**Lamport Last-Write-Wins (LWW):**
- Higher Lamport clock wins.
- If equal: lexicographically higher `deviceId` wins (deterministic tie-break — both devices compute the same winner).

This is encoded in SQL (`ON CONFLICT DO UPDATE SET ... CASE WHEN ...`) on both client and server, so the merge runs atomically and identically everywhere.

### Delete vs. edit

**Delete-wins (remove-wins set semantics):**

If one device sends a tombstone op (`deletedAtClock != null`) and the other sends a concurrent edit, the tombstone always wins — regardless of Lamport clock. A deleted task never silently resurrects.

This is a deliberate, opinionated choice. The alternative (pure Lamport LWW) would mean a late edit can resurrect a deleted study task, which would surprise a student who explicitly removed it. The tradeoff is documented below.

### Convergence argument

The merge function is:
1. **Deterministic**: given the same set of ops, every device computes the same winner.
2. **Commutative**: the winner doesn't depend on the order ops are received (because we sort by Lamport + deviceId before applying, and the merge rule is a pure function of op pairs).
3. **Associative**: applying ops in any grouping (A∪B then C, or A then B∪C) produces the same result.

Therefore, once every device has synced all ops through the server (star topology), all devices are in the same state.

**One caveat — the "loser needs a second pull"**: suppose Device A (clock=5) and Device B (clock=3) both edit task T offline. A syncs first; the server records A's op as the winner. When B syncs, it sends its op (which loses), and the server sends back A's op. B's *local* state may still show B's version until it applies the `tasks` canonical state returned in the sync response. After applying that response B converges. If B sends a second sync, it would get no new ops — it's already consistent. One extra round trip, not a divergence.

---

## 3. Idempotency chain

```
Client op (UUID)
  → server INSERT OR IGNORE into operation_log        [layer 1: op dedup]
  → reward_granted UPDATE WHERE reward_granted = 0    [layer 2: reward claim]
  → recompute(coins/streak/today) from session facts  [layer 3: derive, don't mutate]
  → notification_sent UPDATE WHERE notification_sent=0 [layer 4: webhook claim]
  → n8n: $getWorkflowStaticData processedSessions set [layer 5: workflow dedup]
```

**Layer 3 is the key insight for rewards**: instead of incrementing `coins += 50` on every new session (which would be wrong if the order of arrival is unexpected), we *derive* all reward totals from the full set of completed sessions on each sync call. `coins = COUNT(*) * 50`, `streak` = length of the consecutive-day run ending on the latest focus date, `today_focus_minutes = SUM(actual_duration)/60 WHERE date(started_at) = today`. This is idempotent and order-independent by construction — the correct values fall out of the data no matter what order sessions arrive in or how many times sync runs.

**Layer 4–5 for notifications**: the server atomically sets `notification_sent = 1` before firing the webhook (and rolls back to 0 on failure so it can retry). The n8n workflow independently checks `$getWorkflowStaticData('global').processedSessions[sessionId]` before acting. These two guards are independent: the server guard prevents a second webhook call even if n8n is slow; the n8n guard prevents a second notification even if the server crashed after firing but before committing. Both must fail simultaneously for a duplicate to escape.

---

## 4. Tradeoff: delete-wins vs. pure Lamport LWW

**What was chosen:** delete-wins. A tombstone always beats a concurrent edit.

**Why:** A student who deletes a task on their laptop does not expect it to silently reappear because their phone (which was offline) had an edit to the same task. Resurrection is more surprising than losing an in-flight edit.

**The cost:** a concurrent edit to a task that is simultaneously deleted on another device is silently dropped. The student on the editing device will see their edit disappear on next sync, with no explanation. In a production app this should be surfaced as a conflict ("this task was deleted on another device; your edit was discarded").

**The alternative (pure Lamport LWW):** simpler — one rule for everything. The tradeoff is that a late edit (higher Lamport) can resurrect a deleted task. This is equally defensible if the product decides "the last action wins regardless of type." We chose delete-wins because the "deletion is intentional" heuristic is clearer.

---

## 5. n8n-first then migrate

The `n8n-reward-prototype.json` workflow implements the streak/coins rule entirely in an n8n Code node using workflow static data as a stand-in for the database. This mirrors how Alcovia describes building features: prototype the business logic in n8n (fast iteration, no deploys), then migrate it into Express once it's stable.

The migration (already done in `rewardService.ts`) swapped:
- Static data → SQLite transactions
- Incremental mutation → derive-from-facts approach (see Section 3)
- n8n's in-process execution → server-side atomicity under concurrent requests

The prototype remains importable and runnable as `n8n-reward-prototype.json` to show the before/after.

---

## 6. Where it could still break

- **n8n static data resets on restart.** In a production deployment, use Redis or Postgres for the dedup set, not `$getWorkflowStaticData`.
- **"Today" boundary is server-side.** A session completed at 11:59 PM on a device but received by the server at 12:01 AM counts as "yesterday." For a multi-timezone product, store the date explicitly in the session payload rather than deriving it server-side.
- **Star topology.** Sync is device → server → device. Peers cannot sync directly. If the server is unavailable both devices accumulate ops but cannot merge with each other. In a high-availability scenario, add peer-to-peer sync or a CRDT layer.
- **No authentication.** `studentId` is hardcoded. A malicious client could corrupt another student's data by sending ops with a different `studentId`.
- **Lamport clocks don't bound skew.** Two devices that have never talked to each other might have wildly different clock values (one has been busy, one hasn't). When they first sync, the busy device's ops all win, even if their edits were temporally older. This is correct per the algorithm (more operations = "happened later" in Lamport terms) but may feel counterintuitive. A hybrid logical clock (HLC) would bound this.
