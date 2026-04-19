import { RaftLog } from './raftLog.js';
import { log } from './logger.js';
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
  type LogEntry,
  type Stroke,
  type ClientWriteResult,
  type ReplicaStatus,
} from './types.js';

export class RaftNode {
  // Persistent state
  currentTerm = 0;
  votedFor: string | null = null;
  readonly log = new RaftLog();

  // Volatile state
  state: NodeState = NodeState.Follower;
  leaderId: string | null = null;
  commitIndex = 0;
  lastApplied = 0;

  // Leader-only volatile state
  nextIndex = new Map<string, number>();
  matchIndex = new Map<string, number>();

  // Board state derived from committed entries
  private boardEvents = new Map<string, Stroke[]>();
  private undoneStrokeIds = new Map<string, Set<string>>();
  private boardStrokes = new Map<string, Stroke[]>();

  constructor(
    public readonly replicaId: string,
    public readonly peers: string[],
    private rpcClient: RpcClient,
    private timerManager: TimerManager,
  ) {}

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

  becomeFollower(term: number, leaderId?: string): void {
    const wasLeader = this.state === NodeState.Leader;
    this.state = NodeState.Follower;
    this.currentTerm = term;
    this.votedFor = null;
    if (leaderId !== undefined) this.leaderId = leaderId;
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
    log('info', 'become_candidate', { term: this.currentTerm });
  }

  becomeLeader(): void {
    this.state = NodeState.Leader;
    this.leaderId = this.replicaId;
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

    const results = await Promise.allSettled(
      this.peers.map((peer) => this.rpcClient.requestVote(peer, args)),
    );

    for (const result of results) {
      if (this.state !== NodeState.Candidate) return; // stepped down during election

      if (result.status === 'fulfilled') {
        const reply = result.value;

        if (reply.term > this.currentTerm) {
          this.becomeFollower(reply.term);
          return;
        }

        if (reply.voteGranted) {
          votesGranted++;
          log('info', 'vote_received', { from: reply.responderId, votesGranted, majority });
        } else {
          log('info', 'vote_denied', { from: reply.responderId });
        }
      }
    }

    if (this.state === NodeState.Candidate && votesGranted >= majority) {
      this.becomeLeader();
    } else if (this.state === NodeState.Candidate) {
      log('info', 'election_failed', { votesGranted, majority });
      // Stay candidate, election timer will trigger retry with new random timeout
      this.timerManager.resetElectionTimer();
    }
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
      this.becomeFollower(args.term, args.leaderId);
    } else {
      this.leaderId = args.leaderId;
      this.timerManager.resetElectionTimer();
    }

    // Check log consistency
    if (args.prevLogIndex > 0) {
      const prevEntry = this.log.getEntry(args.prevLogIndex);
      if (!prevEntry || prevEntry.term !== args.prevLogTerm) {
        log('warn', 'append_entries_mismatch', { prevLogIndex: args.prevLogIndex, prevLogTerm: args.prevLogTerm, myLogLength: this.log.getLength() });
        return { term: this.currentTerm, success: false, responderId: this.replicaId, currentLogLength: this.log.getLength() };
      }
    }

    // Append new entries (truncate conflicts)
    for (const entry of args.entries) {
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
      this.becomeFollower(args.term, args.leaderId);
    } else {
      this.leaderId = args.leaderId;
      this.timerManager.resetElectionTimer();
    }

    if (args.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(args.leaderCommit, this.log.getLastIndex());
      this.applyCommitted();
    }

    return { term: this.currentTerm, success: true, responderId: this.replicaId };
  }

  // --- Heartbeat sender (leader) ---

  async sendHeartbeats(): Promise<void> {
    if (this.state !== NodeState.Leader) return;

    const promises = this.peers.map(async (peer) => {
      const nextIdx = this.nextIndex.get(peer) ?? this.log.getLastIndex() + 1;
      const prevLogIndex = nextIdx - 1;
      const prevEntry = this.log.getEntry(prevLogIndex);
      const entries = this.log.getEntriesFrom(nextIdx);

      if (entries.length > 0) {
        // Send AppendEntries with new entries
        const args: AppendEntriesArgs = {
          term: this.currentTerm,
          leaderId: this.replicaId,
          prevLogIndex,
          prevLogTerm: prevEntry?.term ?? 0,
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
            this.nextIndex.set(peer, nextIdx + entries.length);
            this.matchIndex.set(peer, nextIdx + entries.length - 1);
          } else {
            const fromIndex = Math.max(1, result.currentLogLength + 1);
            this.nextIndex.set(peer, fromIndex);
            await this.syncCommittedEntries(peer, fromIndex);
          }
        } catch {
          // Network error — will retry on next heartbeat
        }
      } else {
        // Pure heartbeat
        const hbArgs: HeartbeatArgs = {
          term: this.currentTerm,
          leaderId: this.replicaId,
          leaderCommit: this.commitIndex,
        };
        try {
          const result = await this.rpcClient.sendHeartbeat(peer, hbArgs);
          if (result.term > this.currentTerm) {
            this.becomeFollower(result.term);
          }
        } catch {
          // Network error
        }
      }
    });

    await Promise.allSettled(promises);

    if (this.state === NodeState.Leader) {
      this.updateCommitIndex();
    }
  }

  private async syncCommittedEntries(peer: string, fromIndex: number): Promise<void> {
    if (this.state !== NodeState.Leader) return;
    if (fromIndex > this.commitIndex) return;

    const prevLogIndex = fromIndex - 1;
    const prevEntry = this.log.getEntry(prevLogIndex);
    const entries = this.log
      .getEntriesFrom(fromIndex)
      .filter((entry) => entry.index <= this.commitIndex);

    if (entries.length === 0) return;

    const args: AppendEntriesArgs = {
      term: this.currentTerm,
      leaderId: this.replicaId,
      prevLogIndex,
      prevLogTerm: prevEntry?.term ?? 0,
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
        const lastSynced = entries[entries.length - 1].index;
        this.nextIndex.set(peer, lastSynced + 1);
        this.matchIndex.set(peer, lastSynced);
        log('info', 'sync_committed_done', { peer, fromIndex, toIndex: lastSynced });
      } else {
        const retryFrom = Math.max(1, result.currentLogLength + 1);
        this.nextIndex.set(peer, retryFrom);
        log('warn', 'sync_committed_retry_needed', { peer, fromIndex, retryFrom });
      }
    } catch {
      log('warn', 'sync_committed_failed', { peer, fromIndex });
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
      return { success: false, leaderHint: this.leaderId ?? undefined };
    }

    const entry: LogEntry = {
      index: this.log.getLastIndex() + 1,
      term: this.currentTerm,
      stroke,
    };
    this.log.append(entry);
    this.matchIndex.set(this.replicaId, entry.index);

    log('info', 'client_write_appended', { index: entry.index, strokeId: stroke.id });

    // Replicate to followers
    const majority = Math.floor((this.peers.length + 1) / 2) + 1;
    let ackCount = 1; // self
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const results = await Promise.allSettled(
        this.peers.map(async (peer) => {
          const nextIdx = this.nextIndex.get(peer) ?? entry.index;
          if (nextIdx > entry.index) return { peer, success: true };

          const prevLogIndex = nextIdx - 1;
          const prevEntry = this.log.getEntry(prevLogIndex);
          const entries = this.log.getEntriesFrom(nextIdx);

          const args: AppendEntriesArgs = {
            term: this.currentTerm,
            leaderId: this.replicaId,
            prevLogIndex,
            prevLogTerm: prevEntry?.term ?? 0,
            entries,
            leaderCommit: this.commitIndex,
          };

          const result = await this.rpcClient.appendEntries(peer, args);
          if (result.term > this.currentTerm) {
            this.becomeFollower(result.term);
            return { peer, success: false, stepDown: true };
          }
          if (result.success) {
            this.nextIndex.set(peer, entry.index + 1);
            this.matchIndex.set(peer, entry.index);
            return { peer, success: true };
          } else {
            const fromIndex = Math.max(1, result.currentLogLength + 1);
            this.nextIndex.set(peer, fromIndex);
            await this.syncCommittedEntries(peer, fromIndex);
            return { peer, success: false };
          }
        }),
      );

      if (this.state !== NodeState.Leader) {
        return { success: false, leaderHint: this.leaderId ?? undefined };
      }

      ackCount = 1;
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.success) ackCount++;
      }

      if (ackCount >= majority) break;
    }

    if (ackCount >= majority) {
      this.updateCommitIndex();
      return { success: true };
    }

    log('warn', 'client_write_failed', { index: entry.index, ackCount, majority });
    return { success: false };
  }

  // --- Follower catch-up ---

  async requestCatchUp(): Promise<void> {
    if (this.state !== NodeState.Follower) return;

    // leaderId may be a URL (exact peer match) or a replica name (contained in a peer URL)
    let leaderUrl: string | undefined;
    if (this.leaderId) {
      leaderUrl = this.peers.find((p) => p === this.leaderId) ??
                  this.peers.find((p) => p.includes(this.leaderId!));
    }
    // If leader unknown or not found, try each peer
    const targets = leaderUrl ? [leaderUrl] : [...this.peers];
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

        const committedEntries = result.entries.filter((entry) => entry.index <= result.commitIndex);

        for (const entry of committedEntries) {
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
          this.applyCommitted();
        }

        log('info', 'catch_up_done', { logLength: this.log.getLength(), commitIndex: this.commitIndex });
        return; // success, stop trying
      } catch {
        log('warn', 'catch_up_failed', { target });
      }
    }
  }

  // --- Query methods ---

  getStrokes(boardId: string): Stroke[] {
    return this.boardStrokes.get(boardId) ?? [];
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
