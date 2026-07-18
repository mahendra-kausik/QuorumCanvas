import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RaftNode } from '../../replica/src/raftNode.js';
import { FilePersistence } from '../../replica/src/persistence.js';
import type { RpcClient, TimerManager } from '../../replica/src/types.js';

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

describe('crash recovery (L1 durability)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-crash-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restores currentTerm, votedFor, and the log after a simulated crash + restart', async () => {
    const nodeA = new RaftNode('node-1', ['http://p2', 'http://p3'], mockRpc(), mockTimers(), new FilePersistence(dir));

    nodeA.becomeCandidate(); // term -> 1, votedFor -> node-1
    nodeA.becomeLeader(); // peer RPCs are unresolved mocks, so replication won't reach majority
    await nodeA.handleClientWrite({ id: 's1', boardId: 'b1', userId: 'u1', color: '#f00', width: 2, points: [[0, 0]], timestamp: 1 });

    // "Crash": drop nodeA, build a fresh node on the same DATA_DIR.
    const nodeB = new RaftNode('node-1', ['http://p2', 'http://p3'], mockRpc(), mockTimers(), new FilePersistence(dir));

    expect(nodeB.currentTerm).toBe(nodeA.currentTerm);
    expect(nodeB.votedFor).toBe(nodeA.votedFor);
    expect(nodeB.log.getLength()).toBe(nodeA.log.getLength());
    expect(nodeB.log.getEntry(1)?.stroke.id).toBe('s1');
  });

  it('does not double-vote in the same term across a restart', () => {
    const nodeA = new RaftNode('node-1', ['http://p2', 'http://p3'], mockRpc(), mockTimers(), new FilePersistence(dir));

    const grant = nodeA.handleRequestVote({ term: 1, candidateId: 'candidate-X', lastLogIndex: 0, lastLogTerm: 0 });
    expect(grant.voteGranted).toBe(true);

    // "Restart": fresh node instance reloading the same persisted state.
    const nodeB = new RaftNode('node-1', ['http://p2', 'http://p3'], mockRpc(), mockTimers(), new FilePersistence(dir));

    // Same term, different candidate — without durable votedFor this would wrongly grant again.
    const secondVote = nodeB.handleRequestVote({ term: 1, candidateId: 'candidate-Y', lastLogIndex: 0, lastLogTerm: 0 });
    expect(secondVote.voteGranted).toBe(false);
  });
});
