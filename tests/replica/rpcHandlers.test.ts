import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, type ReplicaConfig } from '../../replica/src/index.js';
import type { RaftNode } from '../../replica/src/raftNode.js';
import type { RpcClient, TimerManager } from '../../replica/src/types.js';
import { createServer, type Server } from 'http';

function mockRpc(): RpcClient {
  return {
    requestVote: vi.fn(),
    appendEntries: vi.fn(),
    // Default to a confirming ack so ReadIndex (L3) doesn't hang tests that don't care about
    // heartbeat behavior; tests that do care override with mockResolvedValueOnce/mockResolvedValue.
    sendHeartbeat: vi.fn().mockResolvedValue({ term: 0, success: true, responderId: 'peer' }),
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

const config: ReplicaConfig = { replicaId: 'test-node', port: 0, peers: ['http://peer1:3001', 'http://peer2:3002'] };

async function request(server: Server, method: string, path: string, body?: unknown) {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('RPC Handlers', () => {
  let server: Server;
  let rpc: RpcClient;
  let raftNode: RaftNode;

  beforeEach(async () => {
    rpc = mockRpc();
    const created = createApp(config, { rpcClient: rpc, timerManager: mockTimers() });
    raftNode = created.raftNode;
    server = createServer(created.app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POST /request-vote returns vote result', async () => {
    const res = await request(server, 'POST', '/request-vote', {
      term: 1, candidateId: 'peer1', lastLogIndex: 0, lastLogTerm: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body.responderId).toBe('test-node');
    expect(res.body.voteGranted).toBe(true);
  });

  it('POST /append-entries returns result', async () => {
    const res = await request(server, 'POST', '/append-entries', {
      term: 1, leaderId: 'peer1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.responderId).toBe('test-node');
  });

  it('POST /heartbeat returns result', async () => {
    const res = await request(server, 'POST', '/heartbeat', {
      term: 1, leaderId: 'peer1', leaderCommit: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /sync-log returns entries', async () => {
    const res = await request(server, 'POST', '/sync-log', {
      fromIndex: 1, term: 0, leaderId: 'peer1',
    });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('POST /client-write rejects when not leader', async () => {
    const res = await request(server, 'POST', '/client-write', {
      stroke: { id: 's1', boardId: 'b1', userId: 'u1', color: '#f00', width: 3, points: [[0, 0]], timestamp: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
  });

  it('GET /status returns replica state', async () => {
    const res = await request(server, 'GET', '/status');
    expect(res.status).toBe(200);
    expect(res.body.replicaId).toBe('test-node');
    expect(res.body.state).toBe('follower');
  });

  it('GET /board-state returns 421 + leaderHint when not leader (ReadIndex, L3)', async () => {
    const res = await request(server, 'GET', '/board-state?boardId=b1');
    expect(res.status).toBe(421);
  });

  it('GET /board-state returns strokes once ReadIndex-confirmed leader', async () => {
    raftNode.becomeCandidate();
    raftNode.becomeLeader(); // mockRpc's sendHeartbeat defaults to a confirming ack
    const res = await request(server, 'GET', '/board-state?boardId=b1');
    expect(res.status).toBe(200);
    expect(res.body.boardId).toBe('b1');
    expect(res.body.strokes).toEqual([]);
  });

  it('GET /board-state without boardId returns 400', async () => {
    const res = await request(server, 'GET', '/board-state');
    expect(res.status).toBe(400);
  });

  it('GET /health still works', async () => {
    const res = await request(server, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
