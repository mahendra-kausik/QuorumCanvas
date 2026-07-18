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
