import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaftNode } from '../../replica/src/raftNode.js';
import type { RpcClient, TimerManager, HeartbeatResult } from '../../replica/src/types.js';

function mockTimers(): TimerManager {
  return {
    startElectionTimer: vi.fn(),
    resetElectionTimer: vi.fn(),
    stopElectionTimer: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
  };
}

function mockRpc(sendHeartbeat: RpcClient['sendHeartbeat']): RpcClient {
  return {
    requestVote: vi.fn(),
    appendEntries: vi.fn(),
    sendHeartbeat,
    syncLog: vi.fn(),
  };
}

function ack(term: number): HeartbeatResult {
  return { term, success: true, responderId: 'peer' };
}

function nack(term: number): HeartbeatResult {
  return { term, success: false, responderId: 'peer' };
}

describe('ReadIndex correct reads (L3)', () => {
  let timers: TimerManager;

  beforeEach(() => {
    timers = mockTimers();
  });

  it('confirmed leader (majority acks) returns success + strokes', async () => {
    const rpc = mockRpc(vi.fn().mockResolvedValue(ack(1)));
    const node = new RaftNode('n1', ['http://n2:3002', 'http://n3:3003'], rpc, timers);
    node.becomeCandidate();
    node.becomeLeader();

    const result = await node.readBoardState('b1');
    expect(result.success).toBe(true);
    expect(result.strokes).toEqual([]);
  });

  // The property this layer exists to add: a leader isolated on the minority side of a
  // partition (no peer acks reach it / all reject) must NOT serve a stale-authoritative read.
  it('minority-partitioned leader (no acks) refuses the read', async () => {
    const rpc = mockRpc(vi.fn().mockRejectedValue(new Error('unreachable')));
    const node = new RaftNode('n1', ['http://n2:3002', 'http://n3:3003'], rpc, timers);
    node.becomeCandidate();
    node.becomeLeader();

    const result = await node.readBoardState('b1');
    expect(result.success).toBe(false);
    expect(result.strokes).toBeUndefined();
  });

  it('a higher-term ack steps the leader down and refuses the read', async () => {
    const rpc = mockRpc(vi.fn().mockResolvedValue(nack(99)));
    const node = new RaftNode('n1', ['http://n2:3002', 'http://n3:3003'], rpc, timers);
    node.becomeCandidate();
    node.becomeLeader();

    const result = await node.readBoardState('b1');
    expect(result.success).toBe(false);
    expect(node.currentTerm).toBe(99);
  });

  it('a follower redirects with the explicit leaderAddr URL (not a name)', async () => {
    const rpc = mockRpc(vi.fn());
    const node = new RaftNode('n1', ['http://n2:3002', 'http://n3:3003'], rpc, timers);

    node.handleAppendEntries({
      term: 1,
      leaderId: 'n2',
      leaderAddr: 'http://n2:3002',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    });

    const result = await node.readBoardState('b1');
    expect(result.success).toBe(false);
    expect(result.leaderHint).toBe('http://n2:3002');
  });
});
