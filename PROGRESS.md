# PROGRESS.md — Mini-RAFT

> Read this FIRST at the start of every session. Update at the end of every layer.

## Last done
- **2026-07-18:** Governance layer established. Created `CLAUDE.md`, `PROJECT_PLAN.md`,
  `DECISIONS.md`, `PROGRESS.md`. Completed a full correctness audit of the Raft core
  (`replica/src/raftNode.ts`, `raftLog.ts`, `rpcHandlers.ts`, `index.ts`,
  `gateway/src/remoteRaftClient.ts`).
- Key audit result: **election restriction and current-term commit rule are already correct**
  (see DECISIONS D02) — they are interview assets, not work items.

## Next up
- **Layer 0 — Baseline & cleanup** (awaiting approval to start per CLAUDE.md PRIME DIRECTIVE):
  remove dead files, move 4→3 replicas, TS strict, pin deps, add per-service config module.
  Gate: 3-node compose healthy + all tests green + end-to-end stroke commits.
- Then **Layer 1 — Durable persistence** (the critical fix): hand-rolled WAL + fsynced
  `state.json`, reload/replay on boot. Gate: crash-recovery + no-double-vote-across-restart tests.

## Prioritized defect backlog (from the audit)
1. **[CRITICAL]** No durable persistence — restart → term 0 / votedFor null → double-vote →
   split-brain / lost commits. → **L1**
2. **[HIGH]** No snapshot / log compaction — unbounded log, full replay on restart. → **L2**
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
