# DEFENSE.md — Mini-RAFT interview-defense pack

> The hard Raft questions, each answered from **this repo's actual code** (`file:line`), not
> from the paper in the abstract. Line numbers are against the tree at Layer 9; if code moves,
> re-grep the named symbol. Deeper rationale for most of these lives in `DECISIONS.md`.

---

### 1. Why a majority quorum?

**Overlap.** Any two majorities of an *N*-node cluster share at least one member, so the set
that elects a new leader intersects the set that acknowledged any committed entry — that shared
node holds the entry and Raft's election restriction (below) guarantees it survives.

- `replica/src/raftNode.ts:459` — `updateCommitIndex` computes `majority = floor((peers+1)/2)+1`
  and only advances `commitIndex` once `replicatedCount >= majority` (`raftNode.ts:472`).
- The same majority constant gates elections (`raftNode.ts:176`) and read confirmation
  (`raftNode.ts:810`) — one definition, three call sites.

### 2. How is commit safety guaranteed?

Two rules together: **election restriction** + the **current-term commit rule** (Raft §5.4).

- **Election restriction** — a candidate only wins if its log is at least as up-to-date as the
  voter's: `isLogUpToDate` compares last-log term then index (`raftNode.ts:273–279`), checked
  inside `handleRequestVote` (`raftNode.ts:252`). A node missing a committed entry can't collect
  a majority, so a new leader always has every committed entry.
- **Current-term commit rule** — a leader never commits a *prior-term* entry by replica count
  alone. `updateCommitIndex` skips any entry whose `entry.term !== this.currentTerm`
  (`raftNode.ts:463`); a prior-term entry only becomes committed indirectly, once a
  current-term entry above it reaches majority. This is the Figure-8 fix from §5.4.2.

### 3. Split vote?

Randomized election timeouts make simultaneous candidacies rare, and a failed election simply
retries — no special resolution logic needed.

- Timeout window **500–800 ms**, heartbeat **150 ms** (`replica/src/config.ts:50–52`) — the
  window sits well above the heartbeat so a live leader pre-empts follower timers.
- `becomeCandidate` bumps term, self-votes, persists (`raftNode.ts:130–138`). If the tally
  falls short, `finalizeElection` keeps the node a **candidate** and resets the election timer
  for a fresh random retry (`raftNode.ts:189–192`) — it does **not** force a follower step-down.

### 4. Log divergence / conflicting entries?

AppendEntries consistency check + truncate-from-conflict, with committed entries protected.

- **Consistency check**: a follower rejects unless `prevLogIndex`/`prevLogTerm` match its own
  log (`raftNode.ts:301–312`, incl. the snapshot-boundary case).
- **Truncate on conflict**: same index, different term → `truncateFrom(index)` drops the
  divergent tail before appending (`raftNode.ts:318–331`; `raftLog.ts:66`).
- **Committed-entry protection**: if the conflicting index is `<= commitIndex`, the follower
  refuses the RPC instead of overwriting committed history (`raftNode.ts:319–326`,
  `append_entries_committed_conflict`). A committed entry is never truncated.

### 5. What breaks without persistence?

A restarted node that forgot `currentTerm`/`votedFor` would **double-vote** in a term → two
leaders → split-brain and lost commits. That's the exact defect Layer 1 closes.

- Term, vote, and commit index are fsynced **before** any dependent RPC reply: `persistState`
  (`raftNode.ts:91`) is called in `becomeFollower`, `becomeCandidate`, and — the no-double-vote
  seam — right after recording a vote in `handleRequestVote`, *before* returning it
  (`raftNode.ts:257–259`). The log fsyncs itself on `append` (`raftLog.ts:34–36`).
- **Before/after proof**: `tests/replica/crashRecovery.test.ts:55` — "does not double-vote in
  the same term across a restart". It fails if `persistState` is removed from the vote path.

### 6. Reads — the stale-read window and how it's closed?

A naive leader read can be stale: a partitioned old leader still *thinks* it leads. Mini-RAFT
uses **ReadIndex** — confirm leadership by a fresh heartbeat majority before serving a read.

- `readBoardState` refuses unless it's the leader **and** `confirmLeadership()` returns true
  (`raftNode.ts:842–854`).
- `confirmLeadership` heartbeats all peers and requires a same-term majority of acks; any
  higher-term reply steps it down (`raftNode.ts:807–834`). A minority-partitioned leader can't
  reach majority, so it returns a redirect (`421`) rather than a stale view.
- **Known bound (documented, not a bug)**: a freshly-elected leader's `commitIndex` can briefly
  lag the true committed index until its first current-term commit — never *wrong* data, just
  briefly behind; self-heals on the next write. No-op-on-election is the named upgrade path
  (`raftNode.ts:836–841`; `DECISIONS.md` D13).

### 7. Why not an off-the-shelf Raft library (etcd/raft, dragonboat)?

**Deliberate.** The project exists to *demonstrate* each safety property from code I can walk a
reviewer through line by line — persistence, the current-term commit rule, ReadIndex, snapshot
install. A dependency would hide exactly what's being tested.

- **Honest tradeoff**: this is a hand-rolled, single-cluster implementation, **not** battle-tested
  at etcd/raft's scale, and it omits dynamic membership (joint consensus), multi-Raft sharding,
  and geo-replication (`PROJECT_PLAN.md` §9). Those are stated as next steps, not silently absent.

---

## Property → test map (the safety net)

| Property | Test |
|---|---|
| Crash recovery restores term/vote/log | `tests/replica/crashRecovery.test.ts:39` |
| No double-vote across restart | `tests/replica/crashRecovery.test.ts:55` |
| ReadIndex refuses on minority-partitioned leader | `tests/replica/readIndex.test.ts` |
| Snapshot + tail recovery, boundary correctness | `tests/replica/snapshot.test.ts` |
| AppendEntries batch cap + coalesced replication | `tests/replica/backpressure.test.ts` |

Full suite: replica **105**, gateway **65**, frontend **41** (`npm test` per service).
