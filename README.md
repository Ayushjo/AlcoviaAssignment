# Alcovia Offline-First Sync

An offline-first study app demonstrating two-device sync, idempotent rewards, and n8n automation. Built with Expo (web), Express, better-sqlite3, and n8n.

## What it does

- **Focus sessions** — start a timer, stay focused for the chosen duration. Completing earns coins and advances a streak. Bailing (tap Give Up) or backgrounding the app for >5 seconds counts as a failed attempt. All of this works fully offline and syncs when a connection returns.
- **Syllabus progress** — mark study tasks through three states (not started → in progress → done). Progress rolls up instantly (chapter % = done/total, subject % = avg chapters). Works offline; edits sync later.
- **Two-device sync** — open the app in two browser tabs with `?device=A` and `?device=B`. Each tab has its own SQLite database (via `expo-sqlite` WASM). They diverge offline and converge when synced through the server — no lost edits, no duplicate rewards, no double notifications.
- **Idempotent rewards** — a completed session is rewarded exactly once regardless of how many times it syncs or from how many devices.
- **n8n automation** — after a successful session is confirmed server-side, a webhook fires to an n8n workflow that sends a notification to a mock sink (proving exactly-once delivery even when both devices sync the same session).

---

## Setup

### Prerequisites

- Node.js ≥ 20
- npx / npm ≥ 9

### Install

```bash
git clone <repo-url>
cd alcovia-sync
npm install
```

### 1. Start the server

```bash
npm run dev:server
# → http://localhost:3001
# Initialises SQLite at server/data/alcovia.db and seeds 27 tasks
```

### 2. Start the n8n workflow

```bash
# Option A: self-hosted (no account needed)
npx n8n

# Option B: n8n Cloud free tier — import the workflow there instead
```

**Import the workflow:**
1. Open n8n UI (default: http://localhost:5678)
2. New Workflow → Import from file → select `n8n-workflow.json`
3. Activate the workflow
4. Copy the webhook URL (looks like `http://localhost:5678/webhook/focus-success`)
5. Create `server/.env` with:
   ```
   N8N_WEBHOOK_URL=http://localhost:5678/webhook/focus-success
   PORT=3001
   ```
6. Restart the server

**Optional: n8n-first prototype workflow** — also import `n8n-reward-prototype.json` to see the reward rule implemented in n8n before it was migrated into Express.

### 3. Launch the app (two devices)

```bash
npm run dev:app
# → Expo web at http://localhost:8081
```

Open two browser tabs (or incognito + regular) at:
- `http://localhost:8081?device=A`
- `http://localhost:8081?device=B`
- `http://localhost:8081?device=C` (optional third device)

Each tab has its own isolated SQLite database. They simulate separate physical devices.

---

## Two-device demo walkthrough

1. Open both tabs (`?device=A` and `?device=B`). Navigate to **Dev Panel** in each.
2. In Device A: tap **Go Offline (stage conflict)**.
3. In Device A: tap **Complete 1-min Session** and **Toggle First Active Task**.
4. In Device B (still online): tap **Toggle First Active Task** on the same task (conflict).
5. In Device A: tap **Go Online + Sync**.
6. Tap **Refresh** in both. Observe:
   - Task states converge to the same winner (higher Lamport clock wins; if same clock, higher device ID wins).
   - Coins and streak are identical in both tabs.
   - The **n8n Notification Sink** section shows the notification fired **exactly once** even though both tabs synced the session.

---

## Conflict cases handled

| Scenario | Resolution |
|---|---|
| Same task edited on both devices offline | Lamport LWW: higher clock wins; lexicographically higher deviceId breaks ties. Deterministic — both devices compute the same winner. |
| Task edited on one device, deleted on other | **Delete-wins**: tombstone beats any concurrent edit regardless of clock. A deleted task never silently resurrects. |
| Same session synced from two devices | `INSERT OR IGNORE` by session ID in `operation_log` + `reward_granted` atomic claim — rewarded exactly once. |
| Same sync request replayed (retry / network hiccup) | Op-log primary key deduplicates incoming ops. Idempotent at every layer. |
| n8n webhook fired more than once | Server: `notification_sent` atomic UPDATE claim. n8n: `$getWorkflowStaticData('global')` sessionId set. Two independent guards. |

---

## What's left out / known limits

- **Star topology**: sync goes through the server, not peer-to-peer. A device that loses a task conflict needs one more sync pull to settle (it sent its "loser" op first, then receives the canonical state back). This is one extra round trip, not a divergence.
- **"Today" boundary**: streak and today's minutes are derived from `date(started_at)` in the server's time zone. A session completed just before midnight on one device but received just after on the server counts for "yesterday." This is a known limitation noted in DECISIONS.md.
- **No authentication**: student ID is hardcoded (`student-001`). In production each device would authenticate.
- **n8n static data** is in-memory in self-hosted n8n; it resets on n8n restart. In production, use a persistent store (Redis, Postgres) for the dedup set.
- **No conflict surfacing to user**: merge is always automatic. Surfacing delete-vs-edit conflicts to the student is a logical next step.

---

## Extensions built

Beyond the core requirements:

1. **Property/fuzz convergence test** (`npm run fuzz`) — 200 random seeds × 50 shuffles × 3 devices. Verifies commutativity (any op ordering → same state), idempotency, correct coin counts, and delete-wins.
2. **Two-way reply loop** — `POST /api/notifications/reply` accepts a student reply (`done`/`snooze`). Available via "Simulate Reply" in the DevPanel; the reply reconciles across devices like any other op.
3. **n8n-first then migrate** — `n8n-reward-prototype.json` implements the streak/coins rule in n8n (using static data as a stand-in for the DB). The same logic then migrated into `server/src/services/rewardService.ts`. See DECISIONS.md for the tradeoff.
4. **3+ device support** — open `?device=C` as a third client; the sync model handles arbitrarily many devices. The DevPanel works for any device ID.

---

## Project structure

```
alcovia-sync/
├── apps/mobile/               # Expo SDK 53 web app
│   └── src/
│       ├── db/                # expo-sqlite client + schema
│       ├── sync/              # SyncEngine, resolver (LWW merge)
│       ├── stores/            # Zustand: focus, syllabus, device
│       └── screens/           # Home, Focus, Syllabus, DevPanel
├── server/                    # Express + better-sqlite3
│   └── src/
│       ├── db/                # schema + seed
│       ├── routes/            # /api/sync, /api/sessions, /api/notifications
│       └── services/          # mergeService, rewardService, n8nService
├── packages/shared/           # TypeScript types + Lamport utilities
├── tools/fuzz.ts              # Property-based convergence test
├── n8n-workflow.json          # Main notification workflow (importable)
├── n8n-reward-prototype.json  # Reward-rule prototype workflow
└── DECISIONS.md               # Sync model, conflict resolution, tradeoffs
```

---

## Running the fuzz test

```bash
npm run fuzz
# Expected output:
# ✓ All 200 seeds × 50 shuffles passed.
#   Commutativity : any ordering of ops converges to the same state
#   Idempotency   : triple-replaying all ops produces the same result
#   Coins         : always = 50 × distinct completed sessions
#   Delete-wins   : tombstones always win over concurrent edits
```
