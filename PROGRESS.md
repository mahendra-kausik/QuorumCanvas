# PROGRESS.md — Mini-RAFT

> Read this FIRST at the start of every session. Update at the end of every layer.

## Last done
- **2026-07-18 — Layer 2 (Snapshot & log compaction) COMPLETE.** Gate passed (evidence below).
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
- **Layer 3 — Correct reads + explicit leader redirect** (awaiting approval per PRIME
  DIRECTIVE): ReadIndex (or leader lease) so `/board-state` can't serve stale committed state
  from a minority-partitioned leader; replace the `leaderId` substring-match redirect
  (`remoteRaftClient.ts:39`) with an explicit address.

## Prioritized defect backlog (from the audit)
1. ~~**[CRITICAL]** No durable persistence — restart → term 0 / votedFor null → double-vote →
   split-brain / lost commits.~~ → **FIXED in L1** (D11).
2. ~~**[HIGH]** No snapshot / log compaction — unbounded log, full replay on restart.~~ →
   **FIXED in L2** (D12).
3. **[HIGH]** Stale reads on minority-partition leader (no ReadIndex/lease). → **L3**
4. **[MED]** Unbounded AppendEntries payload (no batch cap / backpressure). → **L4**
5. **[MED]** `nextIndex`/`matchIndex` race between heartbeat timer and `handleClientWrite`. → **L4**
6. **[LOW]** Leader hint is a name matched by `url.includes()` — fragile. → **L3**
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
