import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaftNode } from '../../replica/src/raftNode.js';
import { MemoryPersistence } from '../../replica/src/persistence.js';
import { NodeState, type RpcClient, type TimerManager, type AppendEntriesResult, type Stroke } from '../../replica/src/types.js';

function makeStroke(id = 's1', boardId = 'b1'): Stroke {
  return { id, boardId, userId: 'u1', color: '#f00', width: 3, points: [[0, 0]], timestamp: 1 };
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

function appendResult(success: boolean, term: number, from: string, logLen = 0): AppendEntriesResult {
  return { term, success, responderId: from, currentLogLength: logLen };
}

// Builds a leader with `count` committed-term-1 entries already in its log, for peer node-2.
function makeLeaderWithEntries(rpc: RpcClient, count: number, batchCap: number): RaftNode {
  const node = new RaftNode(
    'node-1',
    ['http://node-2:3002'],
    rpc,
    mockTimers(),
    new MemoryPersistence(),
    undefined, // snapshotThreshold default
    undefined, // selfUrl default
    batchCap,
  );
  node.becomeCandidate();
  node.becomeLeader();
  for (let i = 1; i <= count; i++) {
    node.log.append({ index: i, term: node.currentTerm, stroke: makeStroke(`s${i}`) });
  }
  return node;
}

describe('RaftNode backpressure (L4)', () => {
  let rpc: RpcClient;

  beforeEach(() => {
    rpc = {
      requestVote: vi.fn(),
      appendEntries: vi.fn(),
      sendHeartbeat: vi.fn(),
      syncLog: vi.fn(),
      installSnapshot: vi.fn(),
    } as unknown as RpcClient;
  });

  it('caps a single AppendEntries batch at the configured limit', async () => {
    const cap = 5;
    const node = makeLeaderWithEntries(rpc, 20, cap);
    (rpc.appendEntries as ReturnType<typeof vi.fn>).mockResolvedValue(appendResult(true, node.currentTerm, 'node-2', 0));

    await node.sendHeartbeats();

    expect(rpc.appendEntries).toHaveBeenCalledTimes(1);
    const args = (rpc.appendEntries as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(args.entries).toHaveLength(cap);
    expect(node.nextIndex.get('http://node-2:3002')).toBe(cap + 1);
  });

  it('a follow-up drive continues from the advanced nextIndex until fully caught up', async () => {
    const cap = 5;
    const node = makeLeaderWithEntries(rpc, 12, cap);
    (rpc.appendEntries as ReturnType<typeof vi.fn>).mockImplementation(
      async (_peer: string, args: { prevLogIndex: number; entries: unknown[] }) =>
        appendResult(true, node.currentTerm, 'node-2', args.prevLogIndex + args.entries.length),
    );

    await node.sendHeartbeats(); // 1..5
    await node.sendHeartbeats(); // 6..10
    await node.sendHeartbeats(); // 11..12

    expect(node.matchIndex.get('http://node-2:3002')).toBe(12);
    expect(rpc.appendEntries).toHaveBeenCalledTimes(3);
  });

  it('coalesces a concurrent heartbeat and client write onto one in-flight send per peer', async () => {
    const node = makeLeaderWithEntries(rpc, 0, 128);
    let inFlight = 0;
    let maxConcurrent = 0;
    (rpc.appendEntries as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return appendResult(true, node.currentTerm, 'node-2', 0);
    });

    // Fire a heartbeat and a client write at the same peer concurrently.
    const heartbeat = node.sendHeartbeats();
    const write = node.handleClientWrite(makeStroke('concurrent'));

    await Promise.all([heartbeat, write]);

    // Only ever one AppendEntries in flight to node-2 at a time — the second caller coalesced
    // onto the first's in-flight promise instead of racing a duplicate send.
    expect(maxConcurrent).toBe(1);
    expect(node.matchIndex.get('http://node-2:3002')).toBe(1);
  });
});
