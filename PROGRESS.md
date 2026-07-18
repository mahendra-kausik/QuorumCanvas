# PROGRESS.md — Mini-RAFT

> Read this FIRST at the start of every session. Update at the end of every layer.

## Last done
- **2026-07-18 — Layer 0 (Baseline & cleanup) COMPLETE.** Gate passed (evidence below).
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
- **Layer 1 — Durable persistence** (the critical fix, awaiting approval per PRIME DIRECTIVE):
  hand-rolled WAL + fsynced `state.json`, reload/replay on boot, new `DATA_DIR` on the
  gitignored instance dirs. Gate: crash-recovery + no-double-vote-across-restart tests (D05).

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
