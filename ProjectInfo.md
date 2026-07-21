# ProjectInfo.md — Mini-RAFT (resume fact bank)

> **How to use this file:** Paste this whole file into Claude *along with a specific job
> description*, then ask: *"Write N resume bullets for this project tailored to this JD,
> drawing only from the facts here — do not invent metrics or features."* This is a neutral,
> complete fact bank, not pre-phrased bullets, so it can be re-angled for SDE, backend,
> distributed-systems, platform, or infra roles. Every number here matches `README.md`,
> which is the reconciled source of truth. Do not fabricate beyond what is stated.

---

## 1. One-liner & elevator paragraph

**One-liner:** A deployed, fault-tolerant, real-time collaborative drawing board whose write
path is a **hand-rolled Raft consensus cluster** (leader election, crash-durable replicated
log, majority commit) written from scratch in TypeScript.

**Elevator paragraph:** Mini-RAFT is a 3-node Raft consensus cluster backing a real-time
collaborative canvas. A React frontend sends strokes over WebSocket to a Node gateway, which
routes every write through the current Raft leader; a stroke becomes visible only after it is
**committed by a majority** of replicas. It is not a toy — it is crash-durable (write-ahead
log + snapshots, fsynced to disk before any dependent RPC reply), serves linearizable reads
via ReadIndex, is observable (Prometheus `/metrics`), auth-gated, benchmarked with a
reproducible harness, and runs at a public URL on free-tier cloud.

---

## 2. Problem / motivation

Distributed systems fail in ways single-node systems don't: crashes mid-write, network
partitions, split-brain leaders, stale reads. Mini-RAFT was built to **demonstrate and defend
every Raft safety property from readable, hand-written code** — persistence, the current-term
commit rule, ReadIndex reads, snapshot install — rather than hiding them behind an off-the-shelf
library. The goal was a resume-defensible systems project: strong engineering (deployed,
observable, correct under failure) plus the ability to explain every design choice and safety
property from the actual code in an interview.

---

## 3. What it implements (feature inventory)

### Raft consensus core (written from scratch)
- **Leader election** with randomized election timeouts (500–800 ms), 150 ms heartbeat, and
  split-vote retry (failed election retries with a fresh random timeout — no special resolution).
- **Crash-durable replicated log** — `currentTerm`, `votedFor`, and log entries are fsynced to a
  write-ahead log **before** any dependent RPC reply is sent (the property the project exists to
  prove). Prevents double-voting / split-brain across restarts.
- **Majority commit** with the **current-term commit rule** (Raft §5.4.2, the Figure-8 fix): a
  leader never commits a prior-term entry by replica count alone.
- **Election restriction** — a candidate wins only if its log is at least as up-to-date as the
  voter's, guaranteeing a new leader has every committed entry.
- **Log consistency check + truncate-on-conflict** — followers reject mismatched
  `prevLogIndex`/`prevLogTerm`; divergent tails are truncated before appending; **committed
  entries are protected from overwrite**.
- **Snapshots & log compaction** — bounded log with InstallSnapshot RPC for far-behind followers.
- **Correct reads via ReadIndex** — leadership is confirmed by a fresh heartbeat majority before
  serving a read; a minority-partitioned leader returns a redirect (HTTP 421) instead of a stale
  view.
- **Backpressure** — AppendEntries batch cap plus a single coalesced replication driver per peer
  (eliminates `nextIndex`/`matchIndex` races from duplicate replication paths).

### Application layer
- Real-time collaborative drawing canvas (React + Vite) over WebSocket.
- Node gateway routes writes to the current leader; explicit leader-URL redirect (not substring
  matching).
- **Undo/redo implemented as compensation entries in the replicated log** (not local-only state).
- Multi-tab support: same user can open multiple tabs on one board; broadcast exclusion is
  per-socket so same-user tabs still see each other.

### Production / operational concerns
- **Observability:** Prometheus `/metrics`, plus `/health`, `/ready`, `/status`, `/cluster-status`.
- **Security (gateway edge):** bearer-token auth, stroke validation with identity binding,
  per-connection rate limiting, CORS allowlist enforcement.
- **Reproducible benchmark harness** (zero external dependencies) measuring load throughput,
  commit-latency percentiles, and timed failover.
- **Containerized:** Docker Compose for the full cluster; **CI** (GitHub Actions) builds and tests
  all three services on push/PR.
- Failure demos: scripted leader-failover and network-partition tests writing timestamped artifacts.

---

## 4. Architecture

**Three services, kept separate:**
- `frontend/` — React + Vite canvas.
- `gateway/` — Node `http`/`ws`; routing, auth, WebSocket fan-out. Not a Raft node.
- `replica/` — the Raft node, kept modular (log/persistence, state machine, RPC handlers, timers,
  transport).

**Write path:** frontend `stroke` over WebSocket → gateway routes it to the current leader's
`POST /client-write` → leader appends to its log, replicates via AppendEntries, commits once a
majority acks → gateway broadcasts the committed stroke to that board's clients. A stroke that
never reaches majority is never broadcast.

**Read / join path:** client `join` → gateway fetches board state from the leader's `/board-state`,
which serves only after a **ReadIndex leadership confirmation** → gateway replies `join_ack` with
the strokes.

---

## 5. Tech stack & keywords

**Stack:** TypeScript (strict) throughout · Node 20 (`http`/`ws`, Express) · React + Vite ·
Docker + Docker Compose · GitHub Actions CI · Prometheus metrics · Vitest · GCP `e2-small`
(free trial) / Oracle Cloud Always Free · Cloudflare Tunnel (public HTTPS/WSS) · Vercel (frontend).

**Distributed-systems keywords (for JD matching):** consensus, Raft, leader election, quorum /
majority commit, replicated log, write-ahead log (WAL), fsync durability, crash recovery,
split-brain prevention, log compaction, snapshots, linearizable reads / ReadIndex, network
partition tolerance, fault tolerance, backpressure, idempotency, high availability, automatic
failover.

---

## 6. Quantified results (the numbers for a resume)

Measured by the zero-dependency harness (`node benchmarks/bench.mjs <load|failover>`), driving
committed writes directly at the leader's `/client-write` (which replies only after majority commit).

| Metric | Local (Docker Desktop) | Live GCP `e2-small` |
|---|---|---|
| Committed writes/s | ~40–41 | **79.0** |
| Commit latency p50 | ~388 ms | **197 ms** |
| Commit latency p99 | ~504–548 ms | **304 ms** |
| Automatic leader failover | 3.36 s | 3.36 s |

- **Workload:** `writes=500 concurrency=16`, single client process (not a hardware ceiling).
- **GCP shape:** `e2-small` (2 vCPU Xeon @2.2 GHz, 1.9 GB RAM), Node 20.
- **Failover** is dominated by the 500–800 ms election-timeout window plus 500 ms harness polling
  granularity, not raw RPC cost. Local numbers reproduce across back-to-back runs.
- **Test suite:** 105 replica + 65 gateway + 41 frontend = **211 tests**; each Raft safety property
  ships with a test that fails if the property breaks.
- **Cluster:** 3 Raft nodes, deployed at a public URL on free-tier cloud.

**Ready-made résumé line (already reconciled):** *Built a crash-durable Raft cluster in TypeScript
(WAL + snapshots) backing a real-time collaborative canvas: **79 committed writes/s**, **p99 304 ms**
commit latency, automatic leader failover in **~3.4 s** across a 3-node cluster; deployed on
free-tier cloud.*

---

## 7. Skills demonstrated (map to JD screening criteria)

- **Distributed systems / systems design:** implemented Raft consensus (election, replication,
  commit safety) from the paper, from scratch.
- **Correctness under failure:** crash-durable persistence, split-brain prevention, partition-safe
  reads — each backed by a regression test.
- **Backend engineering:** multi-service Node/TypeScript system, WebSocket + HTTP APIs, leader
  routing, rate limiting.
- **Observability & operations:** Prometheus metrics, health/readiness endpoints, structured
  lifecycle.
- **Security:** edge auth, input validation with identity binding, CORS allowlist.
- **Performance engineering:** reproducible benchmark harness, latency percentiles, throughput,
  timed failover.
- **DevOps / deployment:** Docker Compose, GitHub Actions CI, free-tier cloud deployment,
  Cloudflare Tunnel, Vercel.
- **Engineering rigor:** decision log with rationale for every non-trivial choice; layered,
  gated build process.

---

## 8. Honest scope & tradeoffs (keeps generated bullets interview-defensible)

- **Single-VM, co-located cluster.** The 3 replicas + gateway run as containers on one VM — this
  proves the consensus protocol, not geo-distributed fault tolerance.
- **Hand-rolled, not battle-tested.** Written to *demonstrate* each safety property from readable
  code, not to compete with etcd/raft at scale.
- **No dynamic membership.** Joint-consensus reconfiguration, multi-Raft sharding, and
  geo-replication are acknowledged next steps, not implemented.
- **No inter-replica TLS.** RPC between replicas is plaintext on a trusted network; auth is
  enforced at the gateway edge only. The gateway token is coarse admission control, not a per-user
  account model.
- **Ephemeral public URL.** The free-tier Cloudflare quick tunnel gets a new hostname on restart.
- **Read-freshness bound.** A freshly-elected leader's `commitIndex` can briefly lag until its
  first current-term commit — never wrong data, self-healing.

> Do **not** claim geo-distribution, dynamic membership, TLS between replicas, or production
> battle-testing in generated bullets — those are explicitly out of scope.

---

## 9. Pointers for depth (if the JD warrants detail)

- `DEFENSE.md` — the hard Raft interview questions answered from actual code (`file:line`).
- `DECISIONS.md` — every non-trivial decision with Context → Decision → Why → Alternatives → Tradeoffs.
- `README.md` — architecture diagram, full API, deployment runbook.
- `benchmarks/README.md` + `benchmarks/results/` — raw benchmark params and machine specs.
