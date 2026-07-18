# DECISIONS.md — Mini-RAFT

> Every non-trivial choice, logged so it can be defended in an interview.
> Newest entries at the top. Do not silently edit old entries — supersede with a new one that references them.

## Entry template

```
### D<NN> — <short title>
- Date:
- Context: what problem/choice prompted this.
- Decision: what we chose.
- Why: the reasoning.
- Alternatives considered: what else, and why not.
- Tradeoffs / risks: what we give up or must watch.
- Supersedes: D<xx> (if any).
```

---

### D14 — Explicit leader address replaces name-substring redirect
- Date: 2026-07-19
- Context: `leaderHint`/`leaderId` was a replica *name* (`"replica1"`), and both the gateway
  (`remoteRaftClient.ts:41`, old code) and a restarting follower's `requestCatchUp` resolved it
  with `peers.find(p => p.includes(hint))` — fragile (`replica1` ⊂ a hypothetical `replica10`)
  and only worked because compose names happened to be unique prefixes.
- Decision: added a parallel `leaderAddr: string | null` (RaftNode) carrying an explicit URL,
  sourced from a new `advertisedUrl` config field (`ADVERTISED_URL` env, default
  `http://${replicaId}:${port}` — already matches how peers reference each other under
  docker-compose, so no compose changes were needed). `AppendEntriesArgs`/`HeartbeatArgs` gained
  an optional `leaderAddr` field the leader stamps on every RPC; followers copy it onto
  `leaderAddr` next to the existing `leaderId`. `handleClientWrite`'s not-leader reply,
  `readBoardState`'s not-leader/unconfirmed reply, and `requestCatchUp`'s target selection all
  switched from `leaderId`/`includes()` to `leaderAddr` directly. `leaderId` (the name) is kept
  as-is for `/status`, logs, and the frontend cluster dashboard — it's a display value, not a
  routing key, and changing that surface wasn't in scope.
- Why: an explicit address is correct by construction; a name is not enough information to
  route on without a lookup that can be wrong.
- Alternatives considered: keep name-only and require peer URLs to be exact-match on the name
  (rejected — still fragile if a deploy renames a host without updating one side); resolve via
  DNS/service-discovery (rejected — free-tier/docker-compose topology doesn't need it, adds a
  dependency for no benefit at this scale).
- Tradeoffs / risks: two leader-identity fields (`leaderId` name, `leaderAddr` URL) now must be
  kept in sync at every call site that sets one — a future change that adds a new leader-setting
  path (e.g. a new RPC type) must remember to set both. `InstallSnapshotArgs` was **not** given a
  `leaderAddr` field (scoped out — that path only fires for a far-behind follower, which will
  also be receiving heartbeats/AppendEntries that carry it moments later); noted here so it's
  not mistaken for an oversight.

### D13 — ReadIndex over leader lease for correct reads; fresh-leader gap documented, not fixed
- Date: 2026-07-19
- Context: `GET /board-state` answered from local state unconditionally. A leader isolated on
  the minority side of a partition still believes it's leader (no RPC has told it otherwise)
  and would serve a stale-authoritative view while the majority side has already elected a new
  leader and moved on — backlog item #3 (HIGH) from the L0 audit.
- Decision: implemented **ReadIndex** (Raft §6.4), not a leader lease. `RaftNode.readBoardState`
  records the current `commitIndex`, then calls a new `confirmLeadership()` which sends the
  already-existing `/heartbeat` RPC to every peer and requires a majority of acks (self + peer
  acks, same term) before answering; any higher-term reply steps the node down
  (`becomeFollower`) and the read is refused. Only on confirmation does it return
  `getStrokes(boardId)`. `rpcHandlers.ts`'s `GET /board-state` returns **421 Misdirected
  Request** + `{ leaderHint }` on refusal (not-leader or unconfirmed) so the gateway can tell
  "not authoritative" apart from "confirmed empty board" (200, `strokes: []`). Gateway
  `remoteRaftClient.getStrokes` follows a 421's `leaderHint` (an explicit URL — see D14) one hop
  before falling through to the next peer.
- Why ReadIndex over lease: no clock-synchronization/bounded-drift assumption between nodes —
  correctness rests only on the same majority-RPC-round argument used everywhere else in this
  Raft implementation, which is what makes it defensible without hedging in an interview. A
  lease would shave the RPC round-trip off every read but requires trusting each node's clock
  drift stays inside the lease window, which this project doesn't want to assume or benchmark.
- **Known bound, not fixed here:** a freshly-elected leader's `commitIndex` reflects only
  entries committed under the current-term commit rule (§5.4.2) — until it commits its first
  current-term entry, `readBoardState` can under-report the last few strokes from before the
  election. This is never *wrong* data and never a stale-from-a-superseded-leader read (the
  property this layer guarantees); it's a narrow, self-closing window (closed by the very next
  committed write) rather than a safety violation. Upgrade path if it ever needs closing: have
  `becomeLeader()` append a no-op `LogEntry` so `commitIndex` becomes current-term-accurate
  immediately — not implemented this layer to keep L3 scoped to the two audit defects and avoid
  extending the stroke/apply path for a bound that's already tightly closed in practice.
- Alternatives considered: leader lease (rejected, clock-assumption above); waiting for
  `lastApplied >= readIndex` with a poll loop (unnecessary — `applyCommitted()` already runs
  synchronously on every commit-index advance, so by the time `confirmLeadership()`'s awaited
  heartbeat round resolves, any concurrently-committed entry up to that point has already been
  applied; no separate wait needed).
- Tradeoffs / risks: every `/board-state` read now costs one extra RPC round-trip (a majority
  heartbeat), versus the previous free local read. Given the read path is a join/refresh
  operation (not a hot per-keystroke path — strokes stream over the websocket separately), this
  cost is accepted without a fallback fast-path.

---

### D12 — L2 snapshot & log compaction implementation choices
- Date: 2026-07-18
- Context: L1 made the WAL durable but unbounded — a cold restart replays the full log, and a
  follower that fell behind the leader's log start had no way to catch up. Implemented across
  `replica/src/raftLog.ts`, `persistence.ts`, `raftNode.ts`, plus a new InstallSnapshot RPC.
- Decision:
  - **Log becomes offset-addressed.** `RaftLog` gained `lastIncludedIndex`/`lastIncludedTerm`;
    every accessor (`getEntry`, `getLastIndex`, `getEntriesFrom`, `truncateFrom`) is offset by
    it, and callers keep using absolute Raft indices unaware compaction happened. `getTermAt`
    added specifically for the AppendEntries `prevLogTerm` consistency check, which must still
    validate at the snapshot boundary itself (where no individual `LogEntry` exists anymore).
  - **Snapshot payload = per-board event list** (not just visible strokes), replayed through the
    existing `applyBoardEvent` — one derivation path for both normal log replay and snapshot
    restore, so undo/redo state reconstructs correctly instead of needing a second serialization
    format.
  - **Snapshot before compact, always.** `takeSnapshot()` persists `snapshot.json` (atomic
    write, same durability as `state.json`) *before* calling `log.compact()`, so a crash between
    the two loses nothing — the WAL still has what the unused snapshot would have covered.
  - **InstallSnapshot has two entry paths, one apply path.** A leader proactively pushes it in
    `sendHeartbeats`/`syncCommittedEntries`/`handleClientWrite` when a peer's `nextIndex` has
    fallen at or below the log's compaction boundary (the entries it needs no longer exist
    individually). A follower's own `requestCatchUp` (used at cold-start) also pulls it via an
    extended `SyncLogResult.snapshot` field when `fromIndex` predates the leader's boundary —
    without this the boot-time catch-up path would silently apply `undefined` for compacted
    indices (a real bug caught while implementing, not just theoretical). Both paths funnel
    through one shared `applySnapshot()` on `RaftNode`.
  - **Threshold:** `RAFT_TIMING.snapshotThresholdEntries = 500` (config default, matches
    PROJECT_PLAN §3), overridable via `SNAPSHOT_THRESHOLD` env / 6th `RaftNode` ctor param —
    `docker-compose.yml` sets it to `20` for demoability without needing hundreds of strokes to
    exercise compaction; real tuning deferred to L8 benchmarks.
- Why: keeps disk and cold-restart time bounded (the whole point of L2) while reusing L1's
  atomic-write primitive and the existing board-apply function rather than inventing new ones.
- Alternatives considered: snapshotting the flattened `boardStrokes` (visible-only) instead of
  the event list — rejected, it would lose undo/redo history and need a second apply path;
  copy-on-write log structure instead of offset indexing — rejected as unnecessary complexity
  for this log's access patterns (sequential append, rare truncate, rare compact).
- Tradeoffs / risks: `takeSnapshot()` and `applySnapshot()` are synchronous full-state
  serializations — fine at demo/interview scale, would need incremental/streaming snapshots at
  much larger board sizes (out of scope, noted for defense). InstallSnapshot ships the entire
  snapshot in one RPC body (no chunking, unlike the paper's `InstallSnapshot` offset/chunk
  fields) — acceptable given board state size at this project's scale; a defensible simplification
  to name explicitly if asked.
- Discovered while implementing: the leader-side `prevLogTerm` computation (`getEntry(idx).term`)
  broke the moment the leader's *own* log compacted past a peer's `nextIndex`, since `getEntry`
  correctly returns `undefined` past the boundary — silently sending `prevLogTerm: 0` and
  causing `append_entries_mismatch` forever. Fixed by switching all four leader-side call sites
  to `getTermAt`, caught live via the Docker e2e gate run (not just unit tests), which is exactly
  why the gate drives real committed writes past the threshold rather than trusting the design
  on paper.
- Supersedes: none (extends D11).

---

### D11 — L1 persistence implementation choices (finalizes D05)
- Date: 2026-07-18
- Context: D05 committed to a hand-rolled WAL + fsynced `state.json` but left the format,
  fsync mechanics, and `commitIndex` durability open. Implemented in `replica/src/persistence.ts`.
- Decision:
  - **Format:** WAL is append-only **JSONL** (one `LogEntry` per line); state is
    `{currentTerm, votedFor, commitIndex}` in a single small JSON file. Both human-inspectable.
  - **Fsync mechanics:** synchronous Node fs calls (`writeSync`/`fsyncSync`, `appendFileSync`
    pattern) so the RPC reply is provably sent only after the sync call returns — no async
    plumbing threaded through every handler. State writes and WAL truncation-rewrites go
    through an atomic temp-file-then-`renameSync` (+ directory fsync) so a crash mid-write
    never leaves a corrupt `state.json` or a partially-truncated log. Directory fsync is a
    no-op on win32 (NTFS/libuv can't fsync a directory fd) — dev-only gap, real on prod Linux.
  - **Torn WAL tail:** only the *last* line can be a partial write from a crash mid-append; the
    loader parses line-by-line and drops an unparseable final line, throws on any earlier one
    (that would indicate real corruption, not a torn write).
  - **commitIndex is persisted** (a deliberate deviation from the paper's volatile
    `commitIndex`): committed entries are never truncated, so persisted `commitIndex ≤ log
    length` always holds — no safety cost — and it lets a solo/cold restart rebuild the board
    from the log immediately instead of waiting for the leader to re-advance commit.
  - **Wiring:** `Persistence` is dependency-injected into `RaftLog`/`RaftNode` (default
    `MemoryPersistence`, so all pre-L1 tests and call sites are untouched); `index.ts`
    constructs `FilePersistence(DATA_DIR)` only when `DATA_DIR` is set.
- Why: keeps the durability mechanics (write-ahead, fsync-before-reply, atomic replace,
  torn-tail handling) fully hand-rolled and explainable, per D05's rationale.
- Alternatives considered: fsync every N entries / debounced (rejected for L1 — batching is
  the documented L4/L8 tuning knob, not a correctness change); volatile commitIndex per the
  strict paper reading (rejected — no safety gain, worse recovery UX).
- Tradeoffs / risks: fsync-per-write costs latency (accepted, to be measured at L8); directory
  fsync doesn't run on Windows dev machines, only prod Linux — noted with a `ponytail:` comment
  at the call site so it isn't mistaken for an oversight.
- Verified: `tests/replica/persistence.test.ts` (state/WAL roundtrip, atomic rewrite, torn-tail
  drop) and `tests/replica/crashRecovery.test.ts` (process-level crash-recovery identity check;
  no-double-vote-across-restart — fails without this change). Docker gate: hard-killed
  `replica2` mid-cluster, `state.json`/`log.jsonl` verified on the host bind mount, restarted
  container reloaded `currentTerm` (did not reset to 0), caught up the write it missed while
  dead, and served the correct board state.

### D10 — Per-replica instance dirs are gitignored runtime state, not source (L0)
- Date: 2026-07-18
- Context: `replica1..4/` each held only a placeholder `README.md` whose sole purpose was to keep the (otherwise empty) Docker bind-mount source dir tracked in git.
- Decision: Delete the placeholder READMEs and gitignore `replica1..3/`; let `docker compose up` create the bind-mount source dirs on the host.
- Why: These dirs are runtime state (and become the L1 WAL/snapshot `DATA_DIR`), not source. Docker auto-creates a missing bind-mount source, so nothing needs to be committed. Removes doc noise the plan flagged.
- Alternatives considered: Replace each README with a `.gitkeep` (still a committed placeholder — same noise); leave as-is (noise + will be overwritten by L1 data anyway).
- Tradeoffs / risks: A fresh clone has no `replica*/` dirs until first `compose up`; acceptable since Docker creates them.

### D09 — Dependency versions pinned exactly to lockfile-resolved versions (L0)
- Date: 2026-07-18
- Context: CLAUDE.md §4 and the L0 gate require reproducible builds; package.json used caret/tilde ranges that let installs drift.
- Decision: Pin every dependency in all three services to the exact version currently resolved in its `package-lock.json` (e.g. `express ^4.21.0` → `4.22.1`), and keep the committed lockfiles as the primary reproducibility mechanism (`npm ci`).
- Why: Exact pins + committed lockfiles make `npm ci` byte-identical across machines and over time, which benchmarks (L8) depend on. Pinning to the *resolved* version (not the old floor) keeps package.json and lock in sync so `npm ci` doesn't error.
- Alternatives considered: Keep ranges and rely on the lockfile alone (works for `npm ci` but `npm install` can silently bump); pin to the old floor version (would desync from lock → `npm ci` failure).
- Tradeoffs / risks: Security/patch updates now require a deliberate bump; acceptable and arguably desirable for a defensible, reproducible project.

### D08 — One config module per service for all tunables (L0)
- Date: 2026-07-18
- Context: Raft timing (election timeout, heartbeat, skew), RPC timeouts, and retry knobs were scattered as magic numbers across `electionTimer.ts`, `rpcClient.ts`, `remoteRaftClient.ts`, and inline `process.env` reads.
- Decision: Add `config.ts` per service (`replica/src/config.ts`, `gateway/src/config.ts`). Env-derived identity/config is parsed by `parseConfig`/`parseGatewayConfig`; fixed tunables live in exported `RAFT_TIMING` / `GATEWAY_TIMING` const objects that the modules import.
- Why: CLAUDE.md §6 — a single source of truth per service makes tuning and benchmark ablations (L8) trivial and every value defensible in an interview. Keeping timing as consts (not env) avoids threading config through constructors and keeps the existing test seams intact (parseConfig still returns exactly `{id,port,peers}`).
- Alternatives considered: Make every knob env-overridable now (more plumbing + would break the parseConfig deep-equal test — YAGNI until benchmarks need it); leave magic numbers in place (fails §6, hard to tune).
- Tradeoffs / risks: Timing changes still require a code edit + redeploy rather than an env flip; env-overridability can be added in the layer that needs it (L8).

### D07 — Governance layer adapted from docsGPT-Agent CLAUDE.md
- Date: 2026-07-18
- Context: Turning Mini-RAFT from lab demo into a deployed, defensible portfolio project needs a repeatable, resume-oriented build process, not ad-hoc edits.
- Decision: Adopt the same operating contract used in the owner's docsGPT-Agent project — `CLAUDE.md` (how), `PROJECT_PLAN.md` (what, layer-by-layer with acceptance gates), `DECISIONS.md` (why), `PROGRESS.md` (state) — retargeted from RAG to Raft.
- Why: The one-layer-at-a-time gate forces correctness and produces an auditable trail of decisions, which is exactly what "defend it in an interview" requires.
- Alternatives considered: Just fix bugs directly (no trail → weak interview story); a single TODO list (no rationale captured).
- Tradeoffs / risks: More documentation overhead per layer; mitigated because the docs *are* the interview prep.

### D06 — Custom Raft retained over an off-the-shelf library
- Date: 2026-07-18
- Context: Could replace the hand-rolled Raft with etcd/raft, dragonboat, or a JS port.
- Decision: Keep the custom TypeScript Raft implementation.
- Why: The entire portfolio value is being able to explain leader election, log replication, and commit safety from code the owner wrote. A library hides exactly what interviews probe.
- Alternatives considered: etcd/raft (Go, battle-tested) — but it moves the interesting logic out of reach; a JS Raft lib — same problem, less mature.
- Tradeoffs / risks: Not battle-tested; must be honest that it is a learning implementation, and back every safety claim with a test.

### D05 — Persistence via hand-rolled WAL + fsynced state.json (Layer 1)
- Date: 2026-07-18
- Context: The critical correctness gap: `currentTerm`, `votedFor`, and the log are in-memory only and never fsynced before RPC replies, so a restart can cause double-voting and split-brain.
- Decision: Implement durability by hand — append-only WAL for log entries, a small fsynced `state.json` for `{currentTerm, votedFor}`, both flushed **before** the dependent RPC reply; reload + replay on boot.
- Why: Raft durability is the single property this project exists to demonstrate; hand-rolling it makes the mechanics (write-ahead, fsync ordering, replay) explainable in an interview.
- Alternatives considered: SQLite/better-sqlite3 (less code but hides the WAL mechanics); LevelDB/RocksDB (realistic but heavier dep and more opaque).
- Tradeoffs / risks: More code and edge cases (partial writes, torn records) to get right; must test crash recovery explicitly. fsync-per-entry costs latency — batching is a later tuning knob (see L4/L8).

### D04 — Deploy the stateful cluster on Oracle Cloud Always Free
- Date: 2026-07-18
- Context: A Raft cluster needs 3+ nodes with persistent disk; the project must be live on a public URL for free.
- Decision: Target Oracle Cloud Always Free (ARM Ampere, real persistent block volumes) for the 3 replicas + gateway; frontend on Vercel/Cloudflare Pages.
- Why: It is the only genuinely always-free option that provides multiple persistent nodes — the exact requirement a Raft cluster has.
- Alternatives considered: Fly.io (good fit but free allowance is now a tiny pay-as-you-go budget → may bill); Render/Railway/Koyeb free (idle spin-down + no persistent disk → invalid Raft nodes).
- Sizing (2026-07): Always Free A1 allowance is **2 OCPUs / 12 GB RAM total** across all A1 instances (Oracle halved the former 4 OCPU / 24 GB, which is now PAYG-only) + 200 GB block storage. This is ample — the 3 replicas + gateway are lightweight Node processes co-located on one VM; CPU/RAM is not the constraint.
- Tradeoffs / risks: Signup needs a card (not charged on Always Free); ARM images required; capacity for free ARM shapes can be intermittent at provision time — claim the A1 instance opportunistically before L7 rather than assuming it will be available on demand.

### D03 — Move from 4 replicas to 3
- Date: 2026-07-18
- Context: The cluster currently runs 4 replicas.
- Decision: Standardize on 3 replicas (odd quorum).
- Why: A 4-node cluster tolerates the same 1 node failure as a 3-node cluster (majority 3 vs 2) but pays more replication overhead and makes split votes likelier. Odd sizes are the Raft norm.
- Alternatives considered: Keep 4 (no benefit); go to 5 (tolerates 2 failures but heavier — overkill for a free-tier demo).
- Tradeoffs / risks: Tolerates only 1 simultaneous failure; acceptable and clearly stated.

### D02 — Correctness audit result: election restriction & commit rule are already correct
- Date: 2026-07-18
- Context: Assumption going in was that core Raft safety might be broken.
- Decision: Treat the election restriction (`isLogUpToDate`) and current-term-only commit rule (`updateCommitIndex`) as **verified assets**, not work items — study them for interview defense rather than rewriting.
- Why: Reading `replica/src/raftNode.ts` in full shows both are implemented per the Raft paper (§5.4.1 up-to-date vote, §5.4.2 no commit of prior-term entries by count).
- Alternatives considered: Rewriting "to be safe" — rejected; it risks regressing correct code and wastes effort.
- Tradeoffs / risks: Must still add tests that pin these properties so a future refactor can't silently break them.

### D01 — Keep the TypeScript / Node / React stack
- Date: 2026-07-18
- Context: Whether to rewrite in Go (closer to real Raft systems) for the upgrade.
- Decision: Keep TS/Node (replica + gateway) and React (frontend).
- Why: The existing implementation, tests, and CI are all TS; a rewrite spends the whole budget on porting instead of the differentiators (durability, snapshots, deploy, benchmarks). TS is also perfectly adequate to demonstrate every Raft property.
- Alternatives considered: Go rewrite (more "systems" credibility but massive rework and loses the working base).
- Tradeoffs / risks: Node's single-threaded async means care around `await` interleaving in replication (addressed in L4); called out rather than hidden.
