# PROGRESS.md — Mini-RAFT

> Read this FIRST at the start of every session. Update at the end of every layer.

## Last done
- **2026-07-19 — Layer 5 (Observability & lifecycle) COMPLETE.** Gate passed (evidence below).
  - **Prometheus `/metrics`** (D16): new `replica/src/metrics.ts`, hand-rolled text exposition
    (no new dependency). Gauges (`raft_state`, `raft_current_term`, `raft_commit_index`,
    `raft_last_applied`, `raft_log_length`) read live from the existing `RaftNode.getStatus()`
    at scrape time; two counters (`raft_elections_started_total`, incremented in
    `becomeCandidate`; `raft_leadership_changes_total`, incremented in `becomeLeader`); one
    fixed-bucket (`5/10/25/50/100/250/500/1000`ms) `raft_write_latency_ms` histogram, observed
    in `handleClientWrite` on a successful majority commit. Wired via a new `/metrics` route in
    `rpcHandlers.ts`.
  - **`/ready` vs `/health`** (D16): `/health` unchanged (liveness — process up). New
    `RaftNode.isReady()` = `state === Leader` OR (`state === Follower` AND `leaderId !== null`)
    — "joined a functioning cluster", not a replication-lag threshold (L4's synchronous
    `applyCommitted()` means `lastApplied` always equals `commitIndex` between commits, so a
    lag-based definition would never gate anything). New `GET /ready` in `index.ts` → 503 when
    not ready, 200 + `{ready, state, leaderId}` otherwise.
  - **Graceful shutdown**: `index.ts` keeps the `http.Server` handle from `app.listen`; SIGTERM
    and SIGINT handlers call `raftNode.stop()` (halts election + heartbeat timers) then
    `server.close(() => process.exit(0))`. No flush step needed — L1's WAL/`state.json` are
    fsynced on every mutation already, so there is no in-memory buffer to lose.
  - **Gate evidence:** `tsc --noEmit` clean (replica). `npm test` green — replica **105/105**
    (101 prior + 4 new in `tests/replica/metrics.test.ts`: `/metrics` exposes all gauge/counter/
    histogram names, a latency observation lands in every bucket ≥ its value and bumps
    sum/count, `/ready` returns 503 for a fresh leaderless follower and 200 once the node
    becomes leader **[the property this layer exists to add]**), gateway **42/42**, frontend
    **41/41** unaffected. Docker e2e (`docker compose up`, 3 replicas + gateway + frontend all
    healthy): `curl replica2:3002/metrics` (the elected leader) returned scrapeable Prometheus
    text; a committed write (`POST /client-write`) advanced `raft_commit_index` 0→1 and recorded
    34ms in the latency histogram (`_count`=1, `_sum`=34, `bucket{le="1000"}`=1). `docker stop`
    (SIGTERM) the leader → logs show clean `shutdown`→`node_stop` (no forced kill needed);
    replica1 won a new election (term 5) — its `/metrics` showed `raft_state`→2 and
    `raft_leadership_changes_total`→1 with `raft_current_term`→5, `commitIndex=1` preserved
    (**no data lost**). `docker start` the stopped replica2 → rejoined at term 5 (not reset to
    0), caught up to `commitIndex=1`, `/ready` returned 200 (**RESULT: PASS**).
- Prior: Layer 4 (Backpressure & single replication driver) COMPLETE. Gate passed
  (evidence below).
  - **Single guarded replication driver** (D15): the three previously-duplicated replication call
    sites (`sendHeartbeats`, `syncCommittedEntries`, `handleClientWrite`'s per-write loop) collapse
    into one `RaftNode.replicateOnce(peer)`, wrapped by `driveReplication(peer)` — a
    `Map<string, Promise<void>>` of in-flight sends per peer. A second caller targeting a peer
    already mid-send awaits the same promise instead of racing a duplicate AppendEntries
    (`replication_coalesced` logged); `nextIndex`/`matchIndex` are now only ever mutated inside one
    drive per peer at a time, closing the heartbeat-timer-vs-client-write race (audit backlog #5).
    `syncCommittedEntries` is deleted — a backed-off peer's `nextIndex` is simply picked up by the
    next drive. `handleClientWrite`'s ack-counting switched from the calling RPC's own result to
    reading `matchIndex` directly — correct regardless of which caller's drive actually advanced a
    coalesced peer.
  - **AppendEntries batch cap** (D15): `replicateOnce` slices
    `getEntriesFrom(nextIdx).slice(0, this.batchCap)` — new `batchCap` ctor param, default
    `RAFT_TIMING.appendEntriesBatchCap = 128`, overridable via `APPEND_ENTRIES_BATCH_CAP` env
    (mirrors L2's `SNAPSHOT_THRESHOLD` pattern) — bounding RPC payload/memory for a far-behind
    follower instead of sending the whole log tail in one message (audit backlog #4).
  - **Gate evidence:** `tsc --noEmit` clean (replica + gateway). `npm test` green — replica
    **101/101** (98 prior + 3 new in `tests/replica/backpressure.test.ts`: a single AppendEntries
    is capped at the configured limit **[the property this layer exists to add]**, a follow-up
    drive resumes from the advanced `nextIndex` until fully caught up, and a concurrent heartbeat +
    client-write to the same peer coalesce onto one in-flight send rather than racing — verified
    via a concurrency counter in the mock RPC client), gateway **42/42**, frontend **41/41**
    unaffected. Docker e2e (`docker compose up`, 3 replicas + gateway healthy, temporary
    `APPEND_ENTRIES_BATCH_CAP=3` to force multi-batch, reverted after): fired 15 sequential writes
    directly at the leader (`POST /client-write`) — **15/15 succeeded**, all 3 replicas converged
    on `commitIndex=15` with identical board state; replica1's logs show **36
    `replication_coalesced` events** during the burst (heartbeat and client-write both targeting
    the same peer concurrently — the race this layer closes) and **zero**
    `append_entries_mismatch`/`sync_committed_retry` churn, with `commit_advance` progressing
    cleanly 1→15 (**RESULT: PASS**).
- Prior: Layer 3 (Correct reads + explicit leader redirect) COMPLETE. Gate passed
  (evidence below).
  - **ReadIndex** (D13): new `RaftNode.confirmLeadership()` sends the existing `/heartbeat` RPC
    to all peers and requires a majority of same-term acks (self + peers) before a read is
    trusted; any higher-term reply steps the node down. New `RaftNode.readBoardState(boardId)`
    records `commitIndex`, calls `confirmLeadership()`, and only then returns
    `getStrokes(boardId)` — `applyCommitted()` already runs synchronously on every commit
    advance so `lastApplied` is caught up by the time the heartbeat round resolves, no wait loop
    needed. `GET /board-state` (`rpcHandlers.ts`) is now `async`; on refusal (not leader, or
    unconfirmed) it replies **421 Misdirected Request** + `{ leaderHint }`, distinct from a
    confirmed-empty board (200, `strokes: []`). Known, documented (not fixed) bound: a
    freshly-elected leader's `commitIndex` can briefly lag the true committed index until its
    first current-term commit — never wrong data, never a stale-from-superseded-leader read,
    self-closing within the next write; no-op-on-election is the named upgrade path.
  - **Explicit leader address** (D14): new `RaftNode.leaderAddr` (URL) tracked alongside the
    existing `leaderId` (name, kept for `/status`/logs/dashboard). Sourced from a new
    `advertisedUrl` config field / `ADVERTISED_URL` env (default `http://${replicaId}:${port}`,
    already matches docker-compose's peer-URL convention — no compose changes needed).
    `AppendEntriesArgs`/`HeartbeatArgs` carry an optional `leaderAddr` the leader stamps on every
    RPC; followers copy it. `handleClientWrite`'s not-leader reply, `readBoardState`'s refusal,
    and `requestCatchUp`'s target selection now use `leaderAddr` directly — the old
    `peers.find(p => p.includes(leaderId))` substring match is gone. Gateway
    `remoteRaftClient.ts`: `submitStroke`'s hint-follow uses the URL directly (no `.find`);
    `getStrokes` gained `tryGetStrokes`/`getRaw` to distinguish 200 (confirmed) from 421
    (follow `leaderHint` one hop, then fall through to the next peer).
  - **Gate evidence:** `tsc --noEmit` clean (replica + gateway). `npm test` green — replica
    **98/98** (93 prior + 5 new in `tests/replica/readIndex.test.ts`: confirmed-leader read,
    minority-partitioned-leader refusal **[the property this layer exists to add]**,
    higher-term-ack step-down, follower redirect carries the URL not a name), gateway **42/42**
    (41 prior + 1 new: `getStrokes` follows a 421 `leaderHint` URL to the real leader), frontend
    **41/41** unaffected. Two pre-existing tests updated for the new behavior/shape
    (`health.test.ts` `parseConfig` shape, `raftNode.test.ts` leaderHint-is-now-a-URL,
    `integration.test.ts` catch-up test sets `leaderAddr` not `leaderId`). Docker e2e
    (`docker compose up`, 3 replicas + gateway all healthy): wrote a stroke directly to the
    leader (replica1) — `GET /board-state` on replica1 returned **200** with the stroke;
    the same request on a follower (replica2) returned **421** `{"leaderHint":
    "http://replica1:3001"}` — an explicit URL, not a name. `docker network disconnect` fully
    partitioned replica1 (old leader) from the cluster and from the host; replica2 won a new
    election (term 4) and served the committed write. Queried replica1 from *inside its own
    container* (loopback, so its own local state was reachable) while still partitioned:
    `GET /board-state` returned **421 Misdirected Request** — the partitioned leader refused to
    serve its stale-authoritative view, confirming ReadIndex's majority-heartbeat check failed
    as designed. Reconnected replica1 — it rejoined, won re-election (term 5), and all 3
    replicas converged on `commitIndex=1` with no data lost (**RESULT: PASS**).
- Prior: Layer 2 (Snapshot & log compaction) COMPLETE.
  - `replica/src/raftLog.ts` reworked to be offset-addressed: `lastIncludedIndex`/
    `lastIncludedTerm` seeded from a loaded snapshot; `getEntry`/`getLastIndex`/
    `getEntriesFrom`/`truncateFrom` all offset-adjusted; new `getTermAt` (term at an index
    including the boundary itself), `compact(uptoIndex, term)`, `installSnapshot(...)`.
  - `persistence.ts`: `Snapshot` type (`lastIncludedIndex/Term` + per-board event lists) moved
    to `types.ts` to avoid a circular import; `FilePersistence` adds `snapshot.json` via the
    existing atomic-write primitive; `MemoryPersistence` no-ops.
  - `raftNode.ts`: restores board state + `lastApplied`/`commitIndex` from a loaded snapshot on
    construct (before log replay); `maybeSnapshot()`/`takeSnapshot()` triggered at the end of
    every `applyCommitted()` once `commitIndex - lastIncludedIndex >= snapshotThreshold` (new
    6th ctor param, defaults to `RAFT_TIMING.snapshotThresholdEntries`); snapshot persisted
    **before** `log.compact()` so a crash between the two loses nothing.
  - New **InstallSnapshot RPC** (`types.ts`, `rpcClient.ts`, `rpcHandlers.ts` `/install-snapshot`):
    leader pushes it from `sendHeartbeats`/`syncCommittedEntries`/`handleClientWrite` when a
    peer's `nextIndex` falls at/below the compaction boundary; a follower's own `requestCatchUp`
    (cold-start path) also pulls it via an extended `SyncLogResult.snapshot` field. Both funnel
    through one shared `applySnapshot()`.
  - `config.ts` adds `snapshotThresholdEntries: 500` + `SNAPSHOT_THRESHOLD` env override;
    `docker-compose.yml` sets it to `20` per replica for demoability.
  - **Bug caught by the e2e gate, not unit tests:** the leader-side `prevLogTerm` computation at
    4 call sites still read `getEntry(idx).term`, which correctly returns `undefined` once the
    leader's own log compacted past that index — silently sent `prevLogTerm: 0`, followers
    rejected forever (`append_entries_mismatch` looping). Fixed by switching all 4 sites to the
    new `getTermAt`. Logged as D12.
  - **Gate evidence:** `tsc --noEmit` clean; `npm test` green — replica **93/93** (88 prior + 5
    new in `tests/replica/snapshot.test.ts`: bounded log after threshold, snapshot+tail recovery
    on restart, offset correctness across the compaction boundary, AppendEntries consistency at
    the boundary, wiped-follower InstallSnapshot + tail), gateway **41/41**, frontend **41/41**
    unaffected. Docker e2e (`SNAPSHOT_THRESHOLD=20`): drove 30 committed strokes to the leader →
    all 3 replicas reached `commitIndex=30`, on-disk `log.jsonl` bounded to **10 lines** (not
    30) with `snapshot.json` present on each host bind mount; `docker rm -f` replica3 + wiped its
    instance dir + restarted → logs show `install_snapshot_applied(lastIncludedIndex=20)` then
    `catch_up_done(logLength=10, commitIndex=30)` — recovered via snapshot + tail, not full
    replay; board state (30 strokes) identical across all 3 replicas (**RESULT: PASS**).
- Prior: Layer 1 (Durable persistence) COMPLETE.
  - New `replica/src/persistence.ts`: `Persistence` interface, `FilePersistence` (JSONL WAL +
    fsynced `state.json` holding `{currentTerm, votedFor, commitIndex}`, atomic temp-file +
    rename + dir-fsync, torn-tail-tolerant loader), `MemoryPersistence` default (D11).
  - `raftLog.ts` takes `Persistence`, seeds from `loadLog()`, fsyncs on `append`/`truncateFrom`.
  - `raftNode.ts` takes `Persistence` (5th, defaulted ctor param); loads
    `{currentTerm, votedFor, commitIndex}` + replays board state on construct; new
    `persistState()` fsyncs before every RPC reply that depends on the change —
    `becomeFollower`, `becomeCandidate`, `handleRequestVote` (the no-double-vote seam), and
    every commit-index advance (`updateCommitIndex`, `handleAppendEntries`, `handleHeartbeat`,
    `requestCatchUp`).
  - `config.ts` adds `DATA_DIR`; `index.ts` wires `FilePersistence` when set;
    `docker-compose.yml` sets `DATA_DIR=/app/instance` for replica1..3 (existing bind mount).
  - **Gate evidence:** `tsc --noEmit` clean; `npm test` green — replica **88/88** (81 prior +
    7 new: `persistence.test.ts` state/WAL roundtrip + atomic rewrite + torn-tail, plus
    `crashRecovery.test.ts` crash-recovery identity and no-double-vote-across-restart, which
    fails without this change), gateway **41/41**, frontend **41/41** unaffected. Docker e2e:
    `docker compose up` all healthy; stroke committed to all 3; `docker kill -9` on replica2
    mid-cluster; second stroke still committed via replica1+replica3 majority; `state.json` +
    `log.jsonl` confirmed on the host bind mount; `docker start` replica2 → reloaded
    `currentTerm=4` (did not reset to 0), caught up the missed write, board state correct
    (**RESULT: PASS**).
- Prior: Layer 0 (Baseline & cleanup) COMPLETE.
  - Cluster 4→3 replicas: `docker-compose.yml`, peer lists, gateway `RAFT_PEERS`, deleted
    `replica4/`; updated README, Documentation.md, and both demo scripts (no `replica4`/`3004` refs left).
  - Removed placeholder `replica{1..4}/README.md`; gitignored `replica1..3/` instance dirs (D10).
  - Added per-service config modules `replica/src/config.ts` (`RAFT_TIMING` + `parseConfig`) and
    `gateway/src/config.ts` (`GATEWAY_TIMING` + `parseGatewayConfig`); rewired electionTimer,
    rpcClient, index, wsServer, remoteRaftClient to source all tunables there (D08).
  - Pinned every dependency to exact lockfile-resolved versions across all 3 services (D09);
    lockfiles synced; `npm ci` succeeds in each (proves lock-consistency).
  - Governance docs committed earlier; repo remote repointed to `QuorumCanvas`.
  - **Gate evidence:** `tsc --noEmit` clean (replica+gateway); `npm test` green — replica **81/81**,
    gateway **41/41**, frontend **41/41**; `docker compose up` → all 5 containers **healthy**;
    e2e: leader elected (replica1, term 3), stroke broadcast to a second WS client and
    committed+replicated to follower replica2 (**RESULT: PASS**).
- Prior: Governance layer + full Raft correctness audit (election restriction & current-term
  commit rule already correct — DECISIONS D02, interview assets).

## Next up
- **Layer 6 — Security hardening** (awaiting approval per PRIME DIRECTIVE): auth on gateway
  WS + HTTP (`AUTH_TOKEN`), per-board authz, input validation + size caps on strokes,
  per-connection rate limit, tighten CORS from `*`, TLS terminated at the platform edge.

## Prioritized defect backlog (from the audit)
1. ~~**[CRITICAL]** No durable persistence — restart → term 0 / votedFor null → double-vote →
   split-brain / lost commits.~~ → **FIXED in L1** (D11).
2. ~~**[HIGH]** No snapshot / log compaction — unbounded log, full replay on restart.~~ →
   **FIXED in L2** (D12).
3. ~~**[HIGH]** Stale reads on minority-partition leader (no ReadIndex/lease).~~ → **FIXED in
   L3** (D13).
4. ~~**[MED]** Unbounded AppendEntries payload (no batch cap / backpressure).~~ → **FIXED in
   L4** (D15).
5. ~~**[MED]** `nextIndex`/`matchIndex` race between heartbeat timer and `handleClientWrite`.~~ →
   **FIXED in L4** (D15).
6. ~~**[LOW]** Leader hint is a name matched by `url.includes()` — fragile.~~ → **FIXED in L3**
   (D14).
7. **[LOW]** 4 replicas (even quorum) — move to 3. → **L0**

Non-Raft hardening tracked in later layers: observability/metrics + graceful shutdown (**L5**),
auth/authz/validation/rate-limit/CORS/TLS (**L6**), deploy (**L7**), benchmarks (**L8**),
defense pack + README (**L9**).

## Open questions
- Oracle Always Free ARM capacity at provision time can be intermittent — confirm shape
  availability before L7; Fly.io is the documented fallback (may bill).
- Snapshot cadence (L2) and AppendEntries batch cap (L4) values to be tuned against L8 benchmarks.

## How to resume
1. Read `CLAUDE.md` §2 (PRIME DIRECTIVE) and §4 (constraints).
2. Read `PROJECT_PLAN.md` §5 for the current layer's scope + Acceptance Gate.
3. Do exactly that one layer, run its gate, update `DECISIONS.md` + this file, then STOP and
   ask before the next layer.
