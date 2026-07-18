# PROJECT_PLAN.md — Mini-RAFT

> The **what**. How to build it lives in `CLAUDE.md`; decisions in `DECISIONS.md`; state in `PROGRESS.md`.
> Work proceeds **one layer at a time** (CLAUDE.md PRIME DIRECTIVE). Each layer has an **Acceptance Gate**.

---

## 1. Problem & goal

Naive real-time collaborative apps broadcast writes directly, so different users can end up
with divergent canvases and there is no authoritative history. Mini-RAFT routes every write
through a **Raft consensus cluster** so a stroke is only shown after it is **committed by a
majority** — giving a single, consistent, crash-durable history that survives node failure,
leader change, and network partition.

**Upgrade goal:** lab demo → production-grade, publicly deployed, interview-defensible.
Success = crash-durable, bounded-growth, correctly-reading, observable, secured, deployed at
a public URL, with reproducible failure/perf numbers and a written defense pack.

---

## 2. Architecture

| Service | Stack | Port(s) | Role |
|---|---|---|---|
| `frontend/` | React 19 + Vite + react-router | 5173 | Canvas, toolbar, live cluster dashboard |
| `gateway/` | Node `http` + `ws` | 8080 (HTTP + `ws://…/ws`) | Board sessions, presence, write routing to leader, status aggregation |
| `replica/` (×3) | Node + Express, custom Raft | 3001–3003 | Raft node: election, replication, commit, board state, **durable log** |

**Write path:** FE `stroke` → gateway `RemoteRaftClient.submitStroke` → leader
`POST /client-write` → append + replicate `AppendEntries` → majority commit → gateway
broadcasts committed stroke.
**Read/join path:** FE `join` → gateway `GET /board-state` → `join_ack` with current strokes.

Cluster moves from **4 → 3 replicas** (odd quorum; same 1-node fault tolerance, less overhead).

---

## 3. Stack & config (targets)

Single config module per service for all tunables. Current / target values:

| Tunable | Where | Value |
|---|---|---|
| Election timeout | replica config | 500–800 ms randomized + per-node skew |
| Heartbeat interval | replica config | 150 ms |
| AppendEntries batch cap | replica config (**new, L4**) | e.g. 128 entries/RPC |
| Snapshot threshold | replica config (**new, L2**) | e.g. every 500 committed entries |
| RPC timeout | gateway + replica | 3000 ms |
| Write retry / backoff | gateway | 5 attempts, 120→1200 ms exp |
| Data dir | replica config (**new, L1**) | `DATA_DIR` (persistent volume) |

Env vars: `REPLICA_ID`, `PORT`, `PEERS`, `DATA_DIR`, `RAFT_PEERS`, `AUTH_TOKEN` (L6),
`VITE_WS_URL`, `VITE_GATEWAY_HTTP_URL`. All are non-secret config except `AUTH_TOKEN`, which
is the one secret (kept out of git, introduced at L6).

---

## 4. Correctness baseline (already verified — defend, don't rebuild)

Confirmed correct in the current code (cite in interviews):
- **Election restriction** — `raftNode.ts:isLogUpToDate` (compares lastLogTerm then
  lastLogIndex), gating `handleRequestVote`.
- **Commit safety** — `updateCommitIndex` only advances commit to **current-term** entries
  (Raft §5.4.2); majority computed from live peer count.
- **Log conflict handling** — truncate-on-conflict + committed-entry conflict rejection in
  `handleAppendEntries` and catch-up.

These are assets. The layers below fix what is genuinely missing.

---

## 5. Build Layers (each STOPS at its gate for approval)

### L0 — Baseline & cleanup
- Remove dead weight: `replica1..4/README.md` placeholder noise, stray `.pptx`.
- Move cluster 4 → 3 replicas (compose + peer lists + gateway `RAFT_PEERS`).
- TS strict everywhere; pin dependency versions; introduce per-service config module.
- **Gate:** `docker compose up` all healthy on 3 nodes; `npm test` green in all services;
  a stroke still commits and broadcasts end-to-end.

### L1 — Durable persistence *(headline correctness fix)*
- Hand-rolled **WAL**: append each `LogEntry` to an append-only file with `fsync` before the
  RPC reply that depends on it; persist `{currentTerm, votedFor}` to a fsynced `state.json`
  before replying to RequestVote / stepping up a term.
- On boot: reload term/vote + replay WAL to rebuild `log`, `commitIndex` guard, and board
  state (`applyCommitted`). New `DATA_DIR` on a persistent volume.
- **Gate:** `kill -9` a node mid-writes → restart → term/vote/log intact, board state
  replays, node rejoins and catches up. Add tests: **crash-recovery** and **no-double-vote
  across restart** (fails on current in-memory code).

### L2 — Snapshot & log compaction
- Periodic snapshot of board state + `lastIncludedIndex/lastIncludedTerm`; truncate WAL
  prefix; `InstallSnapshot`-style path for a follower far behind the leader's log start.
- **Gate:** after N≫threshold writes, on-disk log is bounded (not O(N)); a wiped follower
  recovers via snapshot + tail, not full replay.

### L3 — Correct reads + explicit leader redirect
- Reads: **ReadIndex** (or leader lease) so `/board-state` cannot serve a stale committed
  view from a leader isolated on the minority side of a partition.
- Redirect: leader hint carries an **explicit address**, not a name matched by substring
  (`remoteRaftClient.ts:39`).
- **Gate:** minority-partition read does not return stale-authoritative state (test); gateway
  routes to the real leader with no `includes()` guesswork.

### L4 — Backpressure & single replication driver
- Cap entries per AppendEntries (batch size); one replication driver per peer with an
  **in-flight guard** so the 150 ms heartbeat and a concurrent `handleClientWrite` can't both
  mutate `nextIndex`/`matchIndex` and double-send.
- **Gate:** load test shows bounded RPC payload/memory; logs show no `nextIndex` churn/double
  replication under concurrent writes.

### L5 — Observability & lifecycle
- Structured JSON logs (extend existing `logger`); Prometheus `/metrics` on each replica
  (state, currentTerm, commitIndex, log length, elections started, leadership changes, write
  latency histogram); split `/health` (liveness) vs `/ready` (joined + caught up); graceful
  shutdown on SIGTERM (stop timers, flush WAL/snapshot, close server).
- **Gate:** `/metrics` scrapeable and values move during a failover; SIGTERM persists state
  and exits cleanly (recovers with no data loss).

### L6 — Security hardening
- Auth on gateway WS + HTTP (shared bearer token / JWT via `AUTH_TOKEN`); per-board authz;
  input validation + size caps on strokes; per-connection rate limit; tighten CORS from `*`;
  TLS terminated at the platform edge.
- **Gate:** unauthenticated WS/HTTP rejected; oversized/malformed stroke rejected;
  rate-limited client throttled — each with a test.

### L7 — Deployment (Oracle Cloud Always Free)
- Provision always-free ARM VM(s); persistent block volume mounted at `DATA_DIR` per replica;
  production multi-stage images (build → `node dist`, non-root); scripted bring-up
  (compose or systemd); frontend on Vercel/Cloudflare Pages pointing at the public gateway.
- **Gate:** cluster live at a public URL; failover + catch-up demoable remotely; state
  survives a VM reboot.

### L8 — Proof & benchmarks
- Load-test harness (Node or k6) driving committed writes; scripts to measure the four
  numbers in §7. Results + machine spec + params written to `benchmarks/`.
- **Gate:** reproducible numbers committed; a re-run lands in the same ballpark.

### L9 — Interview-defense pack + README rewrite
- `DEFENSE.md` (or README §) answering the hard Raft questions in §8, each grounded in a
  file:line of this repo. README becomes the "paper": architecture diagram, tradeoffs,
  honest caveats, the benchmark table.
- **Gate:** every defense answer cites real code; README reproduces the deploy + benchmarks.

---

## 6. Deployment topology & free-tier reality

A Raft cluster needs **3+ persistent nodes** → most free tiers are disqualified.

- **Oracle Cloud Always Free (chosen):** ARM Ampere A1, **2 OCPUs / 12 GB RAM total** across all
  A1 instances (Oracle halved the old 4 OCPU / 24 GB allowance — that is now PAYG-only), plus
  200 GB block storage, genuinely always-free with real persistent disks. Ample for 3 replicas +
  gateway as containers on **one VM** (the four Node processes are light; RAM/CPU is not the
  bottleneck). Signup needs a card (not charged on Always Free); ARM A1 capacity can be
  intermittent at provision time. **Best fit for a stateful cluster.**
- **Fly.io (documented alt):** multiple micro-VMs + volumes, clean Raft fit, but the free
  allowance is now a small pay-as-you-go budget → **may bill** beyond tiny scale. Fallback only.
- **Render / Railway / Koyeb free web services:** idle spin-down + no persistent disk on free
  → **will not survive as a Raft node.** Frontend-only at most.
- **Frontend:** Vercel or Cloudflare Pages free (static build), env-pointed at the public gateway.

---

## 7. Proof & metrics (what goes on the resume)

Measure and publish:
1. **Leader-election / failover time** — kill the leader → new leader serving committed writes.
   Target: sub-second to low-seconds given 500–800 ms election timeout.
2. **Write throughput** — committed strokes/sec at steady state.
3. **Commit latency** — p50 / p99 from client submit to majority commit.
4. **Partition behavior** — minority side rejects writes, majority continues, heal reconciles
   with no committed data lost.

Resume bullet (fill in real numbers at L8):
> *Built a crash-durable Raft cluster in TypeScript (WAL + snapshots) backing a real-time
> collaborative canvas: **N** committed writes/s, **p99 X ms** commit latency, automatic
> leader failover in **Y ms** across a 3-node cluster; deployed on free-tier cloud.*

---

## 8. Interview-defense question set (answered in full at L9, grounded in code)

- **Why a majority quorum?** Overlap guarantee — any two majorities intersect, so a newly
  elected leader's voters include someone holding every committed entry.
- **How is commit safety guaranteed?** Leader completeness + the current-term commit rule
  (`updateCommitIndex`, §5.4.2) — a leader never counts prior-term replication as committed.
- **Split vote?** Randomized election timeouts (500–800 ms + skew); candidate stays candidate,
  timer resets, retries next timeout (`runElection` finalize path).
- **Log divergence / conflicting entries?** AppendEntries consistency check + truncate-from-
  conflict, with committed entries protected from overwrite.
- **What breaks without persistence?** A restarted node forgets term/vote → double-votes in a
  term → two leaders → split-brain and lost commits. (This is exactly what L1 fixes; be ready
  to show the before/after test.)
- **Reads?** Explain the stale-read window on a partitioned leader and how ReadIndex/lease (L3)
  closes it.
- **Why not use an off-the-shelf Raft library?** Learning value + full control to demonstrate
  each safety property; tradeoff is it's not battle-tested like etcd/raft (state that honestly).

---

## 9. Out of scope (stated, so the boundary is defensible)
Dynamic cluster membership changes (joint consensus), multi-Raft sharding, and geo-replication
are acknowledged but not implemented — named as "next steps," not silently omitted.
