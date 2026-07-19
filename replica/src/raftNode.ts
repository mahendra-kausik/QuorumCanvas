import { RaftLog } from './raftLog.js';
import { MemoryPersistence, type Persistence } from './persistence.js';
import { log } from './logger.js';
import { RAFT_TIMING } from './config.js';
import { recordElectionStarted, recordLeadershipChange, observeWriteLatency } from './metrics.js';
import {
  NodeState,
  type RpcClient,
  type TimerManager,
  type RequestVoteArgs,
  type RequestVoteResult,
  type AppendEntriesArgs,
  type AppendEntriesResult,
  type HeartbeatArgs,
  type HeartbeatResult,
  type SyncLogArgs,
  type SyncLogResult,
  type InstallSnapshotArgs,
  type InstallSnapshotResult,
  type LogEntry,
  type Stroke,
  type ClientWriteResult,
  type ReadBoardStateResult,
  type ReplicaStatus,
} from './types.js';

export class RaftNode {
  // Persistent state (currentTerm, votedFor, commitIndex fsynced via persistState(); log
  // fsyncs itself in RaftLog.append/truncateFrom — see persistence.ts)
  currentTerm = 0;
  votedFor: string | null = null;
  readonly log: RaftLog;

  // Volatile state
  state: NodeState = NodeState.Follower;
  leaderId: string | null = null;
  // Explicit routing address for the current leader (L3) — set alongside leaderId wherever
  // that is, but used for redirects/catch-up instead of substring-matching leaderId.
  leaderAddr: string | null = null;
  commitIndex = 0;
  lastApplied = 0;

  // Leader-only volatile state
  nextIndex = new Map<string, number>();
  matchIndex = new Map<string, number>();
  // In-flight replication RPC per peer (L4). Guards against the 150ms heartbeat timer and a
  // concurrent handleClientWrite both sending AppendEntries to the same peer at once, which
  // would race on nextIndex/matchIndex and double-send. See driveReplication().
  private replicating = new Map<string, Promise<void>>();

  // Board state derived from committed entries
  private boardEvents = new Map<string, Stroke[]>();
  private undoneStrokeIds = new Map<string, Set<string>>();
  private boardStrokes = new Map<string, Stroke[]>();

  constructor(
    public readonly replicaId: string,
    public readonly peers: string[],
    private rpcClient: RpcClient,
    private timerManager: TimerManager,
    private persistence: Persistence = new MemoryPersistence(),
    private snapshotThreshold: number = RAFT_TIMING.snapshotThresholdEntries,
    // This node's own routing address, advertised as leaderAddr once it becomes leader (L3).
    private selfUrl: string = replicaId,
    // Max log entries per AppendEntries RPC (L4 backpressure).
    private batchCap: number = RAFT_TIMING.appendEntriesBatchCap,
  ) {
    this.log = new RaftLog(persistence);

    // A snapshot's board state and lastIncludedIndex must be restored before applyCommitted()
    // walks the log below, or lastApplied would start at 0 and try to replay entries the
    // snapshot already compacted away.
    const snapshot = persistence.loadSnapshot();
    if (snapshot) {
      this.restoreBoardState(snapshot.boards);
      this.lastApplied = snapshot.lastIncludedIndex;
    }

    const saved = persistence.loadState();
    this.currentTerm = saved.currentTerm;
    this.votedFor = saved.votedFor;
    this.commitIndex = Math.max(saved.commitIndex, this.log.getLastIncludedIndex());
    // Rebuild board state from the persisted log so a solo/cold restart shows it
    // immediately, without waiting on a leader to re-advance commit (DECISIONS D05).
    this.applyCommitted();
  }

  // Fsyncs {currentTerm, votedFor, commitIndex} before returning. Call this BEFORE sending
  // any RPC reply that depends on the value just changed (Raft persistence rule, §5.2/§5.4;
  // CLAUDE.md §4) — see becomeFollower/becomeCandidate/handleRequestVote/commit-advance sites.
  private persistState(): void {
    this.persistence.saveState({
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      commitIndex: this.commitIndex,
    });
  }

  // --- Startup / Shutdown ---

  start(): void {
    log('info', 'node_start', { state: this.state, term: this.currentTerm });
    this.timerManager.startElectionTimer(() => this.onElectionTimeout());
  }

  stop(): void {
    this.timerManager.stopElectionTimer();
    this.timerManager.stopHeartbeat();
    log('info', 'node_stop', { state: this.state, term: this.currentTerm });
  }

  // --- State transitions ---

  becomeFollower(term: number, leaderId?: string, leaderAddr?: string): void {
    const wasLeader = this.state === NodeState.Leader;
    this.state = NodeState.Follower;
    this.currentTerm = term;
    this.votedFor = null;
    if (leaderId !== undefined) this.leaderId = leaderId;
    if (leaderAddr !== undefined) this.leaderAddr = leaderAddr;
    this.persistState();
    log('info', 'become_follower', { term, leaderId: this.leaderId });

    if (wasLeader) {
      this.timerManager.stopHeartbeat();
    }
    this.timerManager.resetElectionTimer();
  }

  becomeCandidate(): void {
    this.state = NodeState.Candidate;
    this.currentTerm++;
    this.votedFor = this.replicaId;
    this.leaderId = null;
    this.persistState();
    recordElectionStarted();
    log('info', 'become_candidate', { term: this.currentTerm });
  }

  becomeLeader(): void {
    this.state = NodeState.Leader;
    this.leaderId = this.replicaId;
    this.leaderAddr = this.selfUrl;
    recordLeadershipChange();
    log('info', 'become_leader', { term: this.currentTerm });

    // Initialize leader volatile state
    const nextIdx = this.log.getLastIndex() + 1;
    for (const peer of this.peers) {
      this.nextIndex.set(peer, nextIdx);
      this.matchIndex.set(peer, 0);
    }

    this.timerManager.stopElectionTimer();
    this.timerManager.startHeartbeat(() => this.sendHeartbeats());
  }

  // --- Election ---

  private onElectionTimeout(): void {
    if (this.state === NodeState.Leader) return;
    log('info', 'election_timeout', { state: this.state, term: this.currentTerm });
    this.runElection();
  }

  async runElection(): Promise<void> {
    this.becomeCandidate();

    const args: RequestVoteArgs = {
      term: this.currentTerm,
      candidateId: this.replicaId,
      lastLogIndex: this.log.getLastIndex(),
      lastLogTerm: this.log.getLastTerm(),
    };

    const majority = Math.floor((this.peers.length + 1) / 2) + 1;
    let votesGranted = 1; // self-vote

    await new Promise<void>((resolve) => {
      let pendingReplies = this.peers.length;
      let settled = false;

      const finalizeElection = (): void => {
        if (settled) return;

        if (this.state === NodeState.Candidate && this.currentTerm === args.term) {
          if (votesGranted >= majority) {
            this.becomeLeader();
          } else {
            log('info', 'election_failed', { votesGranted, majority });
            // Stay candidate, election timer will trigger retry with new random timeout
            this.timerManager.resetElectionTimer();
          }
        }

        settled = true;
        resolve();
      };

      if (pendingReplies === 0) {
        finalizeElection();
        return;
      }

      for (const peer of this.peers) {
        this.rpcClient.requestVote(peer, args)
          .then((reply) => {
            if (settled || this.state !== NodeState.Candidate || this.currentTerm !== args.term) {
              return;
            }

            if (reply.term > this.currentTerm) {
              this.becomeFollower(reply.term);
              finalizeElection();
              return;
            }

            if (reply.voteGranted) {
              votesGranted++;
              log('info', 'vote_received', { from: reply.responderId, votesGranted, majority });
              if (votesGranted >= majority) {
                finalizeElection();
              }
              return;
            }

            log('info', 'vote_denied', { from: reply.responderId });
          })
          .catch(() => {
            // Ignore peer RPC errors; quorum can still be formed from other peers.
          })
          .finally(() => {
            pendingReplies--;
            if (pendingReplies === 0) {
              finalizeElection();
            }
          });
      }
    });
  }

  // --- RequestVote handler ---

  handleRequestVote(args: RequestVoteArgs): RequestVoteResult {
    if (args.term > this.currentTerm) {
      this.becomeFollower(args.term);
    }

    const canVote =
      args.term >= this.currentTerm &&
      (this.votedFor === null || this.votedFor === args.candidateId) &&
      this.isLogUpToDate(args.lastLogIndex, args.lastLogTerm);

    if (canVote) {
      this.votedFor = args.candidateId;
      this.currentTerm = args.term;
      // Fsync the vote BEFORE replying — the durability property this layer exists to add.
      // Without this, a restart forgets the vote and can grant a second vote in this term.
      this.persistState();
      this.timerManager.resetElectionTimer();
      log('info', 'vote_granted', { to: args.candidateId, term: args.term });
    } else {
      log('info', 'vote_rejected', { from: args.candidateId, term: args.term, myTerm: this.currentTerm, votedFor: this.votedFor });
    }

    return {
      term: this.currentTerm,
      voteGranted: canVote,
      responderId: this.replicaId,
    };
  }

  private isLogUpToDate(candidateLastIndex: number, candidateLastTerm: number): boolean {
    const myLastTerm = this.log.getLastTerm();
    if (candidateLastTerm !== myLastTerm) {
      return candidateLastTerm > myLastTerm;
    }
    return candidateLastIndex >= this.log.getLastIndex();
  }

  // --- AppendEntries handler (follower) ---

  handleAppendEntries(args: AppendEntriesArgs): AppendEntriesResult {
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, success: false, responderId: this.replicaId, currentLogLength: this.log.getLength() };
    }

    if (args.term > this.currentTerm || this.state !== NodeState.Follower) {
      this.becomeFollower(args.term, args.leaderId, args.leaderAddr);
    } else {
      this.leaderId = args.leaderId;
      if (args.leaderAddr !== undefined) this.leaderAddr = args.leaderAddr;
      this.timerManager.resetElectionTimer();
    }

    // Check log consistency. Below our snapshot boundary (lastIncludedIndex) we no longer hold
    // individual entries — but everything up to that boundary is already committed, and Raft's
    // committed-entry invariant guarantees it can't conflict with the leader's log, so treat it
    // as consistent (mirrors the InstallSnapshot RPC's role in the paper, §7).
    const lastIncluded = this.log.getLastIncludedIndex();
    if (args.prevLogIndex > lastIncluded) {
      const prevEntry = this.log.getEntry(args.prevLogIndex);
      if (!prevEntry || prevEntry.term !== args.prevLogTerm) {
        log('warn', 'append_entries_mismatch', { prevLogIndex: args.prevLogIndex, prevLogTerm: args.prevLogTerm, myLogLength: this.log.getLength() });
        return { term: this.currentTerm, success: false, responderId: this.replicaId, currentLogLength: this.log.getLength() };
      }
    } else if (args.prevLogIndex === lastIncluded && lastIncluded > 0) {
      if (this.log.getLastIncludedTerm() !== args.prevLogTerm) {
        log('warn', 'append_entries_mismatch_at_boundary', { prevLogIndex: args.prevLogIndex, prevLogTerm: args.prevLogTerm });
        return { term: this.currentTerm, success: false, responderId: this.replicaId, currentLogLength: this.log.getLength() };
      }
    }

    // Append new entries (truncate conflicts)
    for (const entry of args.entries) {
      if (entry.index <= lastIncluded) continue; // already covered by our snapshot
      const existing = this.log.getEntry(entry.index);
      if (existing && existing.term !== entry.term) {
        if (entry.index <= this.commitIndex) {
          log('warn', 'append_entries_committed_conflict', {
            index: entry.index,
            commitIndex: this.commitIndex,
            existingTerm: existing.term,
            incomingTerm: entry.term,
          });
          return { term: this.currentTerm, success: false, responderId: this.replicaId, currentLogLength: this.log.getLength() };
        }
        this.log.truncateFrom(entry.index);
      }
      if (!this.log.getEntry(entry.index)) {
        this.log.append(entry);
      }
    }

    // Update commit index
    if (args.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(args.leaderCommit, this.log.getLastIndex());
      this.persistState();
      this.applyCommitted();
    }

    return { term: this.currentTerm, success: true, responderId: this.replicaId, currentLogLength: this.log.getLength() };
  }

  // --- Heartbeat handler (follower) ---

  handleHeartbeat(args: HeartbeatArgs): HeartbeatResult {
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, success: false, responderId: this.replicaId };
    }

    if (args.term > this.currentTerm || this.state !== NodeState.Follower) {
      this.becomeFollower(args.term, args.leaderId, args.leaderAddr);
    } else {
      this.leaderId = args.leaderId;
      if (args.leaderAddr !== undefined) this.leaderAddr = args.leaderAddr;
      this.timerManager.resetElectionTimer();
    }

    if (args.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(args.leaderCommit, this.log.getLastIndex());
      this.persistState();
      this.applyCommitted();
    }

    return { term: this.currentTerm, success: true, responderId: this.replicaId };
  }

  // --- Heartbeat sender (leader) ---

  async sendHeartbeats(): Promise<void> {
    if (this.state !== NodeState.Leader) return;

    await Promise.allSettled(this.peers.map((peer) => this.driveReplication(peer)));

    if (this.state === NodeState.Leader) {
      this.updateCommitIndex();
    }
  }

  // One replication RPC in flight per peer at a time (L4). A second caller — the 150ms
  // heartbeat timer and a concurrent handleClientWrite both target every peer — awaits the
  // already-in-flight send instead of issuing a duplicate, so nextIndex/matchIndex only ever
  // move under one writer. matchIndex is the single source of truth for "did this replicate":
  // callers who coalesce onto someone else's send still observe its result there.
  private driveReplication(peer: string): Promise<void> {
    const existing = this.replicating.get(peer);
    if (existing) {
      log('info', 'replication_coalesced', { peer });
      return existing;
    }
    const p = this.replicateOnce(peer).finally(() => this.replicating.delete(peer));
    this.replicating.set(peer, p);
    return p;
  }

  // The single AppendEntries/InstallSnapshot send path for a peer — folds together what were
  // previously three duplicated call sites (sendHeartbeats, syncCommittedEntries,
  // handleClientWrite). Caps the batch at this.batchCap (L4 backpressure): a far-behind peer
  // (write burst, wiped-node catch-up) gets its tail in bounded slices, not one unbounded RPC;
  // nextIndex/matchIndex advance by the slice actually sent, so the next drive picks up where
  // this one left off.
  private async replicateOnce(peer: string): Promise<void> {
    if (this.state !== NodeState.Leader) return;

    const nextIdx = this.nextIndex.get(peer) ?? this.log.getLastIndex() + 1;

    // The entries this peer needs (from nextIdx) have already been compacted out of our log —
    // AppendEntries can no longer reconstruct prevLogTerm for it. Send the snapshot instead.
    if (nextIdx <= this.log.getLastIncludedIndex()) {
      await this.sendInstallSnapshot(peer);
      return;
    }

    const prevLogIndex = nextIdx - 1;
    // getTermAt, not getEntry().term — prevLogIndex can sit exactly at (or, after our own
    // compaction races ahead, land on) the snapshot boundary, where getEntry() no longer
    // has an entry to read a term from even though the term itself is still known.
    const prevLogTerm = this.log.getTermAt(prevLogIndex);
    const entries = this.log.getEntriesFrom(nextIdx).slice(0, this.batchCap);

    const args: AppendEntriesArgs = {
      term: this.currentTerm,
      leaderId: this.replicaId,
      leaderAddr: this.selfUrl,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
    };

    try {
      const result = await this.rpcClient.appendEntries(peer, args);
      if (result.term > this.currentTerm) {
        this.becomeFollower(result.term);
        return;
      }

      if (result.success) {
        if (entries.length > 0) {
          this.nextIndex.set(peer, nextIdx + entries.length);
          this.matchIndex.set(peer, nextIdx + entries.length - 1);
        } else {
          const knownMatch = this.matchIndex.get(peer) ?? 0;
          this.matchIndex.set(peer, Math.max(knownMatch, prevLogIndex));
        }
      } else {
        const fromIndex = Math.max(1, result.currentLogLength + 1);
        this.nextIndex.set(peer, fromIndex);
      }
    } catch {
      // Network error — the next heartbeat/write drive will retry from the same nextIndex.
    }
  }

  // --- Commit index advancement (leader) ---

  updateCommitIndex(): void {
    const majority = Math.floor((this.peers.length + 1) / 2) + 1;

    for (let n = this.log.getLastIndex(); n > this.commitIndex; n--) {
      const entry = this.log.getEntry(n);
      if (!entry || entry.term !== this.currentTerm) continue;

      let replicatedCount = 1; // self
      for (const peer of this.peers) {
        if ((this.matchIndex.get(peer) ?? 0) >= n) {
          replicatedCount++;
        }
      }

      if (replicatedCount >= majority) {
        const oldCommit = this.commitIndex;
        this.commitIndex = n;
        this.persistState();
        log('info', 'commit_advance', { from: oldCommit, to: n, term: this.currentTerm });
        this.applyCommitted();
        break;
      }
    }
  }

  // --- Apply committed entries to board state ---

  applyCommitted(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log.getEntry(this.lastApplied);
      if (entry) {
        this.applyBoardEvent(entry.stroke);
        log('info', 'entry_applied', {
          index: this.lastApplied,
          boardId: entry.stroke.boardId,
          strokeId: entry.stroke.id,
          action: entry.stroke.action ?? 'stroke',
        });
      }
    }
    this.maybeSnapshot();
  }

  // --- Snapshot & log compaction (L2) ---

  // Called after every point applyCommitted() advances lastApplied. Snapshotting the derived
  // board state lets us drop the WAL prefix that produced it, bounding on-disk log growth.
  private maybeSnapshot(): void {
    if (this.commitIndex - this.log.getLastIncludedIndex() < this.snapshotThreshold) return;
    this.takeSnapshot();
  }

  private takeSnapshot(): void {
    const boards: Record<string, Stroke[]> = {};
    for (const [boardId, events] of this.boardEvents) {
      boards[boardId] = events;
    }
    const term = this.log.getTermAt(this.commitIndex);
    // Persist the snapshot BEFORE compacting the log — if we crash in between, the WAL still
    // has the entries the (unused) snapshot would have covered, so nothing is lost.
    this.persistence.saveSnapshot({ lastIncludedIndex: this.commitIndex, lastIncludedTerm: term, boards });
    this.log.compact(this.commitIndex, term);
    log('info', 'snapshot_taken', { lastIncludedIndex: this.commitIndex, lastIncludedTerm: term });
  }

  // Rebuilds board state by replaying a snapshot's per-board event lists through the same
  // applyBoardEvent path normal log replay uses — one source of truth for the derivation.
  private restoreBoardState(boards: Record<string, Stroke[]>): void {
    this.boardEvents = new Map();
    this.undoneStrokeIds = new Map();
    this.boardStrokes = new Map();
    for (const events of Object.values(boards)) {
      for (const event of events) {
        this.applyBoardEvent(event);
      }
    }
  }

  // --- InstallSnapshot handler (follower, when the leader's log start has outrun it) ---

  handleInstallSnapshot(args: InstallSnapshotArgs): InstallSnapshotResult {
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, responderId: this.replicaId };
    }
    if (args.term > this.currentTerm || this.state !== NodeState.Follower) {
      this.becomeFollower(args.term, args.leaderId);
    } else {
      this.leaderId = args.leaderId;
      this.timerManager.resetElectionTimer();
    }

    // Stale or already-covered snapshot — ack without regressing our (further-ahead) state.
    if (args.lastIncludedIndex <= this.commitIndex) {
      return { term: this.currentTerm, responderId: this.replicaId };
    }

    this.applySnapshot(args.lastIncludedIndex, args.lastIncludedTerm, args.boards);
    log('info', 'install_snapshot_applied', { lastIncludedIndex: args.lastIncludedIndex });

    return { term: this.currentTerm, responderId: this.replicaId };
  }

  // Installs a snapshot pushed or pulled from a leader: replaces the log's compaction boundary,
  // rebuilds board state from it, and advances commitIndex/lastApplied to match. Shared by the
  // leader-push path (handleInstallSnapshot) and the follower-pull path (requestCatchUp).
  private applySnapshot(lastIncludedIndex: number, lastIncludedTerm: number, boards: Record<string, Stroke[]>): void {
    this.log.installSnapshot(lastIncludedIndex, lastIncludedTerm);
    this.restoreBoardState(boards);
    this.commitIndex = lastIncludedIndex;
    this.lastApplied = lastIncludedIndex;
    this.persistence.saveSnapshot({ lastIncludedIndex, lastIncludedTerm, boards });
    this.persistState();
  }

  // Sends the leader's current snapshot to a peer whose nextIndex has fallen behind the log's
  // compaction boundary (the entries it needs no longer exist individually). On success, advances
  // nextIndex/matchIndex past the boundary so the next heartbeat resumes with normal AppendEntries.
  private async sendInstallSnapshot(peer: string): Promise<void> {
    const snapshot = this.persistence.loadSnapshot();
    if (!snapshot) return; // nothing to send — shouldn't happen if lastIncludedIndex > 0
    const args: InstallSnapshotArgs = {
      term: this.currentTerm,
      leaderId: this.replicaId,
      lastIncludedIndex: snapshot.lastIncludedIndex,
      lastIncludedTerm: snapshot.lastIncludedTerm,
      boards: snapshot.boards,
    };
    try {
      const result = await this.rpcClient.installSnapshot(peer, args);
      if (result.term > this.currentTerm) {
        this.becomeFollower(result.term);
        return;
      }
      this.nextIndex.set(peer, snapshot.lastIncludedIndex + 1);
      this.matchIndex.set(peer, snapshot.lastIncludedIndex);
      log('info', 'install_snapshot_sent', { peer, lastIncludedIndex: snapshot.lastIncludedIndex });
    } catch {
      log('warn', 'install_snapshot_send_failed', { peer });
    }
  }

  private ensureBoardState(boardId: string): void {
    if (!this.boardEvents.has(boardId)) {
      this.boardEvents.set(boardId, []);
    }
    if (!this.undoneStrokeIds.has(boardId)) {
      this.undoneStrokeIds.set(boardId, new Set<string>());
    }
    if (!this.boardStrokes.has(boardId)) {
      this.boardStrokes.set(boardId, []);
    }
  }

  private applyBoardEvent(event: Stroke): void {
    const boardId = event.boardId;
    this.ensureBoardState(boardId);

    const events = this.boardEvents.get(boardId)!;
    const undone = this.undoneStrokeIds.get(boardId)!;
    const visible = this.boardStrokes.get(boardId)!;
    const action = event.action ?? 'stroke';

    events.push(event);

    if (action === 'undo_stroke' && event.targetStrokeId) {
      undone.add(event.targetStrokeId);
      const nextVisible = visible.filter((stroke) => stroke.id !== event.targetStrokeId);
      this.boardStrokes.set(boardId, nextVisible);
      return;
    }

    if (action === 'redo_stroke' && event.targetStrokeId) {
      undone.delete(event.targetStrokeId);
      const alreadyVisible = visible.some((stroke) => stroke.id === event.targetStrokeId);
      if (!alreadyVisible) {
        const target = events.find(
          (strokeEvent) =>
            (strokeEvent.action ?? 'stroke') === 'stroke' &&
            strokeEvent.id === event.targetStrokeId,
        );
        if (target) {
          this.boardStrokes.set(boardId, [...visible, target]);
        }
      }
      return;
    }

    // Default drawing event
    if (!undone.has(event.id)) {
      this.boardStrokes.set(boardId, [...visible, event]);
    }
  }

  // --- SyncLog handler (leader responds to catching-up follower) ---

  handleSyncLog(args: SyncLogArgs): SyncLogResult {
    if (args.term > this.currentTerm) {
      this.becomeFollower(args.term);
    }

    // Caller wants entries from before our snapshot boundary — we no longer hold them
    // individually, so hand back the snapshot itself for the caller to install first.
    if (args.fromIndex <= this.log.getLastIncludedIndex()) {
      const snapshot = this.persistence.loadSnapshot();
      if (snapshot) {
        return { term: this.currentTerm, entries: [], commitIndex: this.commitIndex, snapshot };
      }
    }

    const committedEntries = this.log
      .getEntriesFrom(args.fromIndex)
      .filter((entry) => entry.index <= this.commitIndex);

    return {
      term: this.currentTerm,
      entries: committedEntries,
      commitIndex: this.commitIndex,
    };
  }

  // --- Client write (gateway → leader) ---

  async handleClientWrite(stroke: Stroke): Promise<ClientWriteResult> {
    if (this.state !== NodeState.Leader) {
      return { success: false, leaderHint: this.leaderAddr ?? undefined };
    }

    const writeStartMs = Date.now();
    const entry: LogEntry = {
      index: this.log.getLastIndex() + 1,
      term: this.currentTerm,
      stroke,
    };
    this.log.append(entry);
    this.matchIndex.set(this.replicaId, entry.index);

    log('info', 'client_write_appended', { index: entry.index, strokeId: stroke.id });

    // Replicate to followers. driveReplication funnels through the single guarded per-peer
    // driver (L4) — if a heartbeat is already mid-send to a peer, this coalesces onto it rather
    // than racing a second AppendEntries. Acks are counted from matchIndex, not from whichever
    // RPC happened to resolve here, since a coalesced peer's progress is recorded by the
    // in-flight send this call merely awaited.
    const majority = Math.floor((this.peers.length + 1) / 2) + 1;
    let ackCount = 1; // self
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await Promise.allSettled(this.peers.map((peer) => this.driveReplication(peer)));

      if (this.state !== NodeState.Leader) {
        return { success: false, leaderHint: this.leaderAddr ?? undefined };
      }

      ackCount = 1;
      for (const peer of this.peers) {
        if ((this.matchIndex.get(peer) ?? 0) >= entry.index) ackCount++;
      }

      if (ackCount >= majority) break;
    }

    if (ackCount >= majority) {
      this.updateCommitIndex();
      observeWriteLatency(Date.now() - writeStartMs);
      return { success: true };
    }

    log('warn', 'client_write_failed', { index: entry.index, ackCount, majority });
    return { success: false };
  }

  // --- Follower catch-up ---

  async requestCatchUp(): Promise<void> {
    if (this.state !== NodeState.Follower) return;

    // leaderAddr is the explicit URL learned from AppendEntries/Heartbeat (L3) — no more
    // name-substring guessing against the peer list.
    const targets = this.leaderAddr ? [this.leaderAddr] : [...this.peers];
    if (targets.length === 0) return;

    log('info', 'catch_up_start', { leader: this.leaderId, fromIndex: this.log.getLastIndex() + 1 });

    for (const target of targets) {
      try {
        const result = await this.rpcClient.syncLog(target, {
          fromIndex: this.log.getLastIndex() + 1,
          term: this.currentTerm,
          leaderId: this.leaderId ?? '',
        });

        if (result.term > this.currentTerm) {
          this.becomeFollower(result.term);
        }

        // Leader's log start has outrun the entries we asked for — install its snapshot before
        // (or instead of) applying any entries this response carries.
        if (result.snapshot && result.snapshot.lastIncludedIndex > this.commitIndex) {
          this.applySnapshot(result.snapshot.lastIncludedIndex, result.snapshot.lastIncludedTerm, result.snapshot.boards);
          log('info', 'catch_up_installed_snapshot', { lastIncludedIndex: result.snapshot.lastIncludedIndex });
        }

        const lastIncluded = this.log.getLastIncludedIndex();
        const committedEntries = result.entries.filter((entry) => entry.index <= result.commitIndex);

        for (const entry of committedEntries) {
          if (entry.index <= lastIncluded) continue; // already covered by the snapshot just installed
          const existing = this.log.getEntry(entry.index);
          if (existing && existing.term !== entry.term) {
            if (entry.index <= this.commitIndex) {
              log('warn', 'catch_up_committed_conflict', {
                index: entry.index,
                commitIndex: this.commitIndex,
                existingTerm: existing.term,
                incomingTerm: entry.term,
              });
              continue;
            }
            this.log.truncateFrom(entry.index);
          }

          if (!this.log.getEntry(entry.index)) {
            this.log.append(entry);
          }
        }

        if (result.commitIndex > this.commitIndex) {
          this.commitIndex = Math.min(result.commitIndex, this.log.getLastIndex());
          this.persistState();
          this.applyCommitted();
        }

        log('info', 'catch_up_done', { logLength: this.log.getLength(), commitIndex: this.commitIndex });
        return; // success, stop trying
      } catch {
        log('warn', 'catch_up_failed', { target });
      }
    }
  }

  // --- ReadIndex (L3): confirm this node is still leader before serving a read ---

  // Raft §6.4: a leader isolated on the minority side of a partition doesn't know it has been
  // superseded until an RPC informs it. A majority of heartbeat acks (still this term, no
  // higher term seen) proves no new leader has been elected — only then is it safe to answer
  // reads from local state instead of a stale view. Reuses the existing /heartbeat RPC; no
  // clock/lease assumptions.
  private async confirmLeadership(): Promise<boolean> {
    if (this.state !== NodeState.Leader) return false;
    const term = this.currentTerm;
    const majority = Math.floor((this.peers.length + 1) / 2) + 1;
    let acks = 1; // self

    const args: HeartbeatArgs = {
      term,
      leaderId: this.replicaId,
      leaderAddr: this.selfUrl,
      leaderCommit: this.commitIndex,
    };

    const results = await Promise.allSettled(
      this.peers.map((peer) => this.rpcClient.sendHeartbeat(peer, args)),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      if (r.value.term > this.currentTerm) {
        this.becomeFollower(r.value.term);
        return false;
      }
      if (r.value.success) acks++;
    }

    return this.state === NodeState.Leader && this.currentTerm === term && acks >= majority;
  }

  // Serves /board-state only after confirming leadership via confirmLeadership(), so a
  // minority-partitioned leader can't hand back a stale-authoritative view (the defect this
  // layer fixes). Known bound: a freshly-elected leader's commitIndex may briefly lag the true
  // committed index until it commits a current-term entry — never wrong data, just briefly
  // behind (see DECISIONS.md D13; no-op-on-election is the named upgrade path, not implemented
  // here).
  async readBoardState(boardId: string): Promise<ReadBoardStateResult> {
    if (this.state !== NodeState.Leader) {
      return { success: false, leaderHint: this.leaderAddr ?? undefined };
    }

    const confirmed = await this.confirmLeadership();
    if (!confirmed) {
      return { success: false, leaderHint: this.leaderAddr ?? undefined };
    }

    // applyCommitted() runs synchronously on every commit-index advance, so lastApplied is
    // already caught up to commitIndex by the time confirmLeadership() resolves — no wait loop.
    return { success: true, strokes: this.getStrokes(boardId) };
  }

  // --- Query methods ---

  getStrokes(boardId: string): Stroke[] {
    return this.boardStrokes.get(boardId) ?? [];
  }

  // Readiness (L5) — "joined a functioning cluster", not a replication-lag threshold: lastApplied
  // catches up to commitIndex synchronously on every commit (applyCommitted), so a lag-based
  // definition would trivially always read 0 and add nothing.
  isReady(): boolean {
    return this.state === NodeState.Leader || (this.state === NodeState.Follower && this.leaderId !== null);
  }

  getStatus(): ReplicaStatus {
    return {
      replicaId: this.replicaId,
      state: this.state,
      currentTerm: this.currentTerm,
      leaderId: this.leaderId,
      logLength: this.log.getLength(),
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
    };
  }
}
