import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RaftNode } from '../../replica/src/raftNode.js';
import { RaftLog } from '../../replica/src/raftLog.js';
import { FilePersistence } from '../../replica/src/persistence.js';
import type {
  RpcClient,
  TimerManager,
  Stroke,
  AppendEntriesResult,
  InstallSnapshotArgs,
  InstallSnapshotResult,
} from '../../replica/src/types.js';

function makeStroke(id: string, boardId = 'b1'): Stroke {
  return { id, boardId, userId: 'u1', color: '#f00', width: 2, points: [[0, 0]], timestamp: 1 };
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

// An RpcClient whose appendEntries always "succeeds" so handleClientWrite's replication reaches
// majority immediately without a real peer — lets us drive commitIndex forward deterministically.
function ackingRpc(): RpcClient {
  return {
    requestVote: vi.fn(),
    appendEntries: vi.fn(async (): Promise<AppendEntriesResult> => ({
      term: 0,
      success: true,
      responderId: 'peer',
      currentLogLength: 0,
    })),
    sendHeartbeat: vi.fn(),
    syncLog: vi.fn(),
    installSnapshot: vi.fn(async (): Promise<InstallSnapshotResult> => ({ term: 0, responderId: 'peer' })),
  };
}

describe('snapshot & log compaction (L2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-snap-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function writeAndCommit(node: RaftNode, strokeId: string): Promise<void> {
    const result = await node.handleClientWrite(makeStroke(strokeId));
    expect(result.success).toBe(true);
  }

  it('bounds the on-disk log once committed entries pass the snapshot threshold', async () => {
    const threshold = 5;
    const node = new RaftNode('node-1', ['http://p2', 'http://p3'], ackingRpc(), mockTimers(), new FilePersistence(dir), threshold);
    node.becomeCandidate();
    node.becomeLeader();

    for (let i = 0; i < 12; i++) {
      await writeAndCommit(node, `s${i}`);
    }

    // On-disk WAL should only hold the tail past the last snapshot boundary, not all 12 entries.
    expect(node.log.getLength()).toBeLessThan(12);
    expect(node.log.getLastIndex()).toBe(12);
    expect(node.getStrokes('b1')).toHaveLength(12);
  });

  it('recovers board state from a snapshot + tail without replaying compacted entries', async () => {
    const threshold = 5;
    const nodeA = new RaftNode('node-1', ['http://p2', 'http://p3'], ackingRpc(), mockTimers(), new FilePersistence(dir), threshold);
    nodeA.becomeCandidate();
    nodeA.becomeLeader();
    for (let i = 0; i < 12; i++) {
      await writeAndCommit(nodeA, `s${i}`);
    }

    const boundaryBefore = nodeA.log.getLastIncludedIndex();
    expect(boundaryBefore).toBeGreaterThan(0); // a snapshot did happen

    // "Crash": fresh node instance over the same DATA_DIR (simulates restart).
    const nodeB = new RaftNode('node-1', ['http://p2', 'http://p3'], ackingRpc(), mockTimers(), new FilePersistence(dir), threshold);

    expect(nodeB.lastApplied).toBe(12);
    expect(nodeB.commitIndex).toBe(12);
    expect(nodeB.getStrokes('b1')).toHaveLength(12);
    expect(nodeB.log.getLastIncludedIndex()).toBe(boundaryBefore);
    // The compacted prefix must be gone from the on-disk log too, not just skipped in memory.
    expect(nodeB.log.getEntry(1)).toBeUndefined();
  });

  it('RaftLog offset: getEntry/getTermAt/getEntriesFrom are correct across a compaction boundary', () => {
    const log = new RaftLog();
    for (let i = 1; i <= 5; i++) {
      log.append({ index: i, term: 1, stroke: makeStroke(`s${i}`) });
    }

    log.compact(3, 1);

    expect(log.getLastIncludedIndex()).toBe(3);
    expect(log.getLastIncludedTerm()).toBe(1);
    expect(log.getEntry(3)).toBeUndefined(); // compacted away
    expect(log.getEntry(4)?.stroke.id).toBe('s4');
    expect(log.getTermAt(3)).toBe(1); // boundary term still known
    expect(log.getLength()).toBe(2); // only entries 4,5 remain on disk/in memory
    expect(log.getLastIndex()).toBe(5);
    expect(log.getEntriesFrom(1)).toHaveLength(2);
    expect(log.getEntriesFrom(4)[0].index).toBe(4);
  });

  it('handleAppendEntries accepts a prevLogIndex exactly at the snapshot boundary', () => {
    // A follower that already has a snapshot up to index 2 (no individual entries below it).
    const persistence = new FilePersistence(fs.mkdtempSync(path.join(os.tmpdir(), 'raft-snap-boundary-')));
    persistence.saveSnapshot({ lastIncludedIndex: 2, lastIncludedTerm: 1, boards: {} });
    const node = new RaftNode('node-2', ['http://p2'], ackingRpc(), mockTimers(), persistence);

    const result = node.handleAppendEntries({
      term: 1,
      leaderId: 'leader',
      prevLogIndex: 2,
      prevLogTerm: 1,
      entries: [{ index: 3, term: 1, stroke: makeStroke('s3') }],
      leaderCommit: 3,
    });

    expect(result.success).toBe(true);
    expect(node.log.getEntry(3)?.stroke.id).toBe('s3');
  });

  it('installs a leader-pushed snapshot on a wiped follower, then accepts the tail', async () => {
    // Leader: commits past the threshold so it holds a snapshot + short tail.
    const leaderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-snap-leader-'));
    const leader = new RaftNode('leader', ['http://follower'], ackingRpc(), mockTimers(), new FilePersistence(leaderDir), 5);
    leader.becomeCandidate();
    leader.becomeLeader();
    for (let i = 0; i < 8; i++) {
      await writeAndCommit(leader, `s${i}`);
    }

    const snapshot = new FilePersistence(leaderDir).loadSnapshot();
    expect(snapshot).not.toBeNull();

    // Wiped follower: empty DATA_DIR, receives the leader's InstallSnapshot RPC directly.
    const followerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-snap-follower-'));
    const follower = new RaftNode('follower', ['http://leader'], ackingRpc(), mockTimers(), new FilePersistence(followerDir));

    const installResult = follower.handleInstallSnapshot({
      term: 1,
      leaderId: 'leader',
      lastIncludedIndex: snapshot!.lastIncludedIndex,
      lastIncludedTerm: snapshot!.lastIncludedTerm,
      boards: snapshot!.boards,
    } satisfies InstallSnapshotArgs);

    expect(installResult.term).toBe(1);
    expect(follower.commitIndex).toBe(snapshot!.lastIncludedIndex);
    expect(follower.getStrokes('b1')).toHaveLength(snapshot!.lastIncludedIndex);

    // Now the leader's tail (entries past the snapshot) applies normally via AppendEntries.
    const tail = leader.log.getEntriesFrom(snapshot!.lastIncludedIndex + 1);
    const tailResult = follower.handleAppendEntries({
      term: 1,
      leaderId: 'leader',
      prevLogIndex: snapshot!.lastIncludedIndex,
      prevLogTerm: snapshot!.lastIncludedTerm,
      entries: tail,
      leaderCommit: leader.commitIndex,
    });

    expect(tailResult.success).toBe(true);
    expect(follower.getStrokes('b1')).toHaveLength(8);
  });
});
