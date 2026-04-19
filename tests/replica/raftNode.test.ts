import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaftNode } from '../../replica/src/raftNode.js';
import { NodeState, type RpcClient, type TimerManager, type RequestVoteResult, type AppendEntriesResult, type HeartbeatResult, type SyncLogResult, type Stroke } from '../../replica/src/types.js';

function makeStroke(id = 's1', boardId = 'b1'): Stroke {
  return { id, boardId, userId: 'u1', color: '#f00', width: 3, points: [[0, 0]], timestamp: 1 };
}

function mockRpc(): RpcClient {
  return {
    requestVote: vi.fn(),
    appendEntries: vi.fn(),
    sendHeartbeat: vi.fn(),
    syncLog: vi.fn(),
  };
}

function mockTimers(): TimerManager {
  return {
    startElectionTimer: vi.fn(),
    resetElectionTimer: vi.fn(),
    stopElectionTimer: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
  };
}

function voteResult(granted: boolean, term: number, from: string): RequestVoteResult {
  return { term, voteGranted: granted, responderId: from };
}

function appendResult(success: boolean, term: number, from: string, logLen = 0): AppendEntriesResult {
  return { term, success, responderId: from, currentLogLength: logLen };
}

describe('RaftNode', () => {
  let node: RaftNode;
  let rpc: RpcClient;
  let timers: TimerManager;

  beforeEach(() => {
    rpc = mockRpc();
    timers = mockTimers();
    node = new RaftNode('node-1', ['http://node-2:3002', 'http://node-3:3003'], rpc, timers);
  });

  describe('initial state', () => {
    it('starts as follower at term 0', () => {
      expect(node.state).toBe(NodeState.Follower);
      expect(node.currentTerm).toBe(0);
      expect(node.votedFor).toBeNull();
      expect(node.leaderId).toBeNull();
    });

    it('start() begins election timer', () => {
      node.start();
      expect(timers.startElectionTimer).toHaveBeenCalled();
    });
  });

  describe('state transitions', () => {
    it('becomeCandidate increments term and votes for self', () => {
      node.becomeCandidate();
      expect(node.state).toBe(NodeState.Candidate);
      expect(node.currentTerm).toBe(1);
      expect(node.votedFor).toBe('node-1');
      expect(node.leaderId).toBeNull();
    });

    it('becomeFollower resets votedFor and updates term', () => {
      node.becomeCandidate();
      node.becomeFollower(5, 'node-2');
      expect(node.state).toBe(NodeState.Follower);
      expect(node.currentTerm).toBe(5);
      expect(node.votedFor).toBeNull();
      expect(node.leaderId).toBe('node-2');
    });

    it('becomeLeader initializes nextIndex/matchIndex and starts heartbeat', () => {
      node.becomeCandidate();
      node.becomeLeader();
      expect(node.state).toBe(NodeState.Leader);
      expect(node.leaderId).toBe('node-1');
      expect(timers.stopElectionTimer).toHaveBeenCalled();
      expect(timers.startHeartbeat).toHaveBeenCalled();
      expect(node.nextIndex.get('http://node-2:3002')).toBe(1);
      expect(node.matchIndex.get('http://node-2:3002')).toBe(0);
    });

    it('becomeFollower from leader stops heartbeat', () => {
      node.becomeCandidate();
      node.becomeLeader();
      node.becomeFollower(10);
      expect(timers.stopHeartbeat).toHaveBeenCalled();
      expect(timers.resetElectionTimer).toHaveBeenCalled();
    });
  });

  describe('handleRequestVote', () => {
    it('grants vote when term matches and has not voted', () => {
      const result = node.handleRequestVote({
        term: 1, candidateId: 'node-2', lastLogIndex: 0, lastLogTerm: 0,
      });
      expect(result.voteGranted).toBe(true);
      expect(node.votedFor).toBe('node-2');
    });

    it('rejects vote when already voted for someone else this term', () => {
      node.handleRequestVote({ term: 1, candidateId: 'node-2', lastLogIndex: 0, lastLogTerm: 0 });
      const result = node.handleRequestVote({ term: 1, candidateId: 'node-3', lastLogIndex: 0, lastLogTerm: 0 });
      expect(result.voteGranted).toBe(false);
    });

    it('grants vote again to same candidate in same term', () => {
      node.handleRequestVote({ term: 1, candidateId: 'node-2', lastLogIndex: 0, lastLogTerm: 0 });
      const result = node.handleRequestVote({ term: 1, candidateId: 'node-2', lastLogIndex: 0, lastLogTerm: 0 });
      expect(result.voteGranted).toBe(true);
    });

    it('rejects vote when candidate log is behind', () => {
      // Give node a log entry at term 2
      node.currentTerm = 2;
      node.log.append({ index: 1, term: 2, stroke: makeStroke() });

      const result = node.handleRequestVote({
        term: 3, candidateId: 'node-2', lastLogIndex: 0, lastLogTerm: 0,
      });
      expect(result.voteGranted).toBe(false);
    });

    it('steps down on higher term', () => {
      node.becomeCandidate(); // term 1
      node.handleRequestVote({ term: 5, candidateId: 'node-2', lastLogIndex: 0, lastLogTerm: 0 });
      expect(node.state).toBe(NodeState.Follower);
      expect(node.currentTerm).toBe(5);
    });

    it('rejects stale term', () => {
      node.currentTerm = 5;
      const result = node.handleRequestVote({ term: 3, candidateId: 'node-2', lastLogIndex: 0, lastLogTerm: 0 });
      expect(result.voteGranted).toBe(false);
    });
  });

  describe('runElection', () => {
    it('becomes leader when majority grants votes', async () => {
      (rpc.requestVote as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(voteResult(true, 1, 'node-2'))
        .mockResolvedValueOnce(voteResult(true, 1, 'node-3'));

      await node.runElection();
      expect(node.state).toBe(NodeState.Leader);
      expect(node.currentTerm).toBe(1);
    });

    it('stays candidate when only self votes (no majority)', async () => {
      (rpc.requestVote as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(voteResult(false, 1, 'node-2'))
        .mockResolvedValueOnce(voteResult(false, 1, 'node-3'));

      await node.runElection();
      expect(node.state).toBe(NodeState.Candidate);
    });

    it('resets election timer after split vote', async () => {
      (rpc.requestVote as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(voteResult(false, 1, 'node-2'))
        .mockResolvedValueOnce(voteResult(false, 1, 'node-3'));

      await node.runElection();
      expect(node.state).toBe(NodeState.Candidate);
      expect(timers.resetElectionTimer).toHaveBeenCalled();
    });

    it('becomes leader with only one peer granting (2 of 3 = majority)', async () => {
      (rpc.requestVote as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(voteResult(true, 1, 'node-2'))
        .mockResolvedValueOnce(voteResult(false, 1, 'node-3'));

      await node.runElection();
      expect(node.state).toBe(NodeState.Leader);
    });

    it('steps down if a peer has higher term', async () => {
      (rpc.requestVote as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(voteResult(false, 5, 'node-2'))
        .mockResolvedValueOnce(voteResult(false, 5, 'node-3'));

      await node.runElection();
      expect(node.state).toBe(NodeState.Follower);
      expect(node.currentTerm).toBe(5);
    });

    it('handles network errors gracefully', async () => {
      (rpc.requestVote as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'));

      await node.runElection();
      expect(node.state).toBe(NodeState.Candidate); // no votes, stays candidate
    });
  });

  describe('handleAppendEntries', () => {
    it('rejects stale term', () => {
      node.currentTerm = 5;
      const result = node.handleAppendEntries({
        term: 3, leaderId: 'node-2', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0,
      });
      expect(result.success).toBe(false);
      expect(result.term).toBe(5);
    });

    it('accepts valid append with empty entries (heartbeat-like)', () => {
      const result = node.handleAppendEntries({
        term: 1, leaderId: 'node-2', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0,
      });
      expect(result.success).toBe(true);
      expect(node.leaderId).toBe('node-2');
    });

    it('appends new entries', () => {
      const entry = { index: 1, term: 1, stroke: makeStroke() };
      const result = node.handleAppendEntries({
        term: 1, leaderId: 'node-2', prevLogIndex: 0, prevLogTerm: 0, entries: [entry], leaderCommit: 0,
      });
      expect(result.success).toBe(true);
      expect(node.log.getLength()).toBe(1);
    });

    it('rejects when prevLogIndex does not match', () => {
      const entry = { index: 2, term: 1, stroke: makeStroke() };
      const result = node.handleAppendEntries({
        term: 1, leaderId: 'node-2', prevLogIndex: 1, prevLogTerm: 1, entries: [entry], leaderCommit: 0,
      });
      expect(result.success).toBe(false);
    });

    it('updates commitIndex from leaderCommit', () => {
      const entry = { index: 1, term: 1, stroke: makeStroke() };
      node.handleAppendEntries({
        term: 1, leaderId: 'node-2', prevLogIndex: 0, prevLogTerm: 0, entries: [entry], leaderCommit: 1,
      });
      expect(node.commitIndex).toBe(1);
      expect(node.lastApplied).toBe(1);
    });

    it('steps down from candidate on valid append', () => {
      node.becomeCandidate();
      node.handleAppendEntries({
        term: 1, leaderId: 'node-2', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0,
      });
      expect(node.state).toBe(NodeState.Follower);
    });

    it('rejects conflicting overwrite of committed entries', () => {
      node.log.append({ index: 1, term: 1, stroke: makeStroke('s1') });
      node.commitIndex = 1;
      node.applyCommitted();

      const result = node.handleAppendEntries({
        term: 2,
        leaderId: 'node-2',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [{ index: 1, term: 2, stroke: makeStroke('s1-conflict') }],
        leaderCommit: 1,
      });

      expect(result.success).toBe(false);
      expect(node.log.getEntry(1)?.term).toBe(1);
      expect(node.commitIndex).toBe(1);
      expect(node.getStrokes('b1').map((s) => s.id)).toEqual(['s1']);
    });
  });

  describe('handleHeartbeat', () => {
    it('resets election timer on valid heartbeat', () => {
      node.handleHeartbeat({ term: 1, leaderId: 'node-2', leaderCommit: 0 });
      expect(timers.resetElectionTimer).toHaveBeenCalled();
      expect(node.leaderId).toBe('node-2');
    });

    it('rejects stale term', () => {
      node.currentTerm = 5;
      const result = node.handleHeartbeat({ term: 3, leaderId: 'node-2', leaderCommit: 0 });
      expect(result.success).toBe(false);
    });

    it('updates commitIndex from leaderCommit', () => {
      node.log.append({ index: 1, term: 1, stroke: makeStroke() });
      node.handleHeartbeat({ term: 1, leaderId: 'node-2', leaderCommit: 1 });
      expect(node.commitIndex).toBe(1);
      expect(node.lastApplied).toBe(1);
    });
  });

  describe('updateCommitIndex', () => {
    it('advances commitIndex when majority has replicated', () => {
      node.becomeCandidate();
      node.becomeLeader();

      node.log.append({ index: 1, term: 1, stroke: makeStroke() });
      node.matchIndex.set('http://node-2:3002', 1);
      node.matchIndex.set('http://node-3:3003', 0);

      node.updateCommitIndex();
      expect(node.commitIndex).toBe(1);
    });

    it('does not advance if no majority', () => {
      node.becomeCandidate();
      node.becomeLeader();

      node.log.append({ index: 1, term: 1, stroke: makeStroke() });
      node.matchIndex.set('http://node-2:3002', 0);
      node.matchIndex.set('http://node-3:3003', 0);

      node.updateCommitIndex();
      expect(node.commitIndex).toBe(0);
    });

    it('only commits entries from current term', () => {
      node.currentTerm = 2;
      node.state = NodeState.Leader;

      // Entry from old term
      node.log.append({ index: 1, term: 1, stroke: makeStroke('s1') });
      node.matchIndex.set('http://node-2:3002', 1);
      node.matchIndex.set('http://node-3:3003', 1);

      node.updateCommitIndex();
      expect(node.commitIndex).toBe(0); // can't commit old-term entry

      // Entry from current term
      node.log.append({ index: 2, term: 2, stroke: makeStroke('s2') });
      node.matchIndex.set('http://node-2:3002', 2);

      node.updateCommitIndex();
      expect(node.commitIndex).toBe(2); // commits both
    });
  });

  describe('handleSyncLog', () => {
    it('returns entries from requested index', () => {
      node.log.append({ index: 1, term: 1, stroke: makeStroke('s1') });
      node.log.append({ index: 2, term: 1, stroke: makeStroke('s2') });
      node.commitIndex = 2;

      const result = node.handleSyncLog({ fromIndex: 2, term: 1, leaderId: 'node-1' });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].index).toBe(2);
      expect(result.commitIndex).toBe(2);
    });

    it('returns only committed entries', () => {
      node.log.append({ index: 1, term: 1, stroke: makeStroke('s1') });
      node.log.append({ index: 2, term: 1, stroke: makeStroke('s2') });
      node.log.append({ index: 3, term: 1, stroke: makeStroke('s3') });
      node.commitIndex = 2;

      const result = node.handleSyncLog({ fromIndex: 1, term: 1, leaderId: 'node-1' });
      expect(result.entries).toHaveLength(2);
      expect(result.entries.map((entry) => entry.index)).toEqual([1, 2]);
      expect(result.commitIndex).toBe(2);
    });
  });

  describe('handleClientWrite', () => {
    it('rejects write if not leader', async () => {
      const result = await node.handleClientWrite(makeStroke());
      expect(result.success).toBe(false);
    });

    it('returns leaderHint if known', async () => {
      node.leaderId = 'node-2';
      const result = await node.handleClientWrite(makeStroke());
      expect(result.leaderHint).toBe('node-2');
    });

    it('commits write when majority acks', async () => {
      node.becomeCandidate();
      node.becomeLeader();

      (rpc.appendEntries as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(appendResult(true, 1, 'node-2', 1))
        .mockResolvedValueOnce(appendResult(true, 1, 'node-3', 1));

      const result = await node.handleClientWrite(makeStroke());
      expect(result.success).toBe(true);
      expect(node.log.getLength()).toBe(1);
      expect(node.commitIndex).toBe(1);
    });

    it('fails when no majority acks after retries', async () => {
      node.becomeCandidate();
      node.becomeLeader();

      (rpc.appendEntries as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('timeout'));

      const result = await node.handleClientWrite(makeStroke());
      expect(result.success).toBe(false);
    });
  });

  describe('requestCatchUp', () => {
    it('fetches missing entries from leader', async () => {
      node.leaderId = 'http://node-2:3002';
      node.currentTerm = 1;
      (rpc.syncLog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        term: 1,
        entries: [
          { index: 1, term: 1, stroke: makeStroke('s1') },
          { index: 2, term: 1, stroke: makeStroke('s2') },
        ],
        commitIndex: 2,
      } satisfies SyncLogResult);

      await node.requestCatchUp();
      expect(node.log.getLength()).toBe(2);
      expect(node.commitIndex).toBe(2);
      expect(node.lastApplied).toBe(2);
    });

    it('applies only committed entries from sync-log response', async () => {
      node.leaderId = 'http://node-2:3002';
      node.currentTerm = 1;
      (rpc.syncLog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        term: 1,
        entries: [
          { index: 1, term: 1, stroke: makeStroke('s1') },
          { index: 2, term: 1, stroke: makeStroke('s2') },
          { index: 3, term: 1, stroke: makeStroke('s3') },
        ],
        commitIndex: 2,
      } satisfies SyncLogResult);

      await node.requestCatchUp();
      expect(node.log.getLength()).toBe(2);
      expect(node.commitIndex).toBe(2);
      expect(node.getStrokes('b1').map((stroke) => stroke.id)).toEqual(['s1', 's2']);
    });

    it('tries all peers when no leader known', async () => {
      // No leaderId set, but syncLog calls fail — just verify it tries peers
      (rpc.syncLog as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));
      await node.requestCatchUp();
      expect(rpc.syncLog).toHaveBeenCalledTimes(2); // tries both peers
    });
  });

  describe('board state', () => {
    it('getStrokes returns committed strokes by board', () => {
      node.log.append({ index: 1, term: 1, stroke: makeStroke('s1', 'board-a') });
      node.log.append({ index: 2, term: 1, stroke: makeStroke('s2', 'board-b') });
      node.commitIndex = 2;
      node.applyCommitted();

      expect(node.getStrokes('board-a')).toHaveLength(1);
      expect(node.getStrokes('board-b')).toHaveLength(1);
      expect(node.getStrokes('board-c')).toEqual([]);
    });

    it('getStatus returns current state', () => {
      const status = node.getStatus();
      expect(status.replicaId).toBe('node-1');
      expect(status.state).toBe(NodeState.Follower);
      expect(status.currentTerm).toBe(0);
    });
  });
});
