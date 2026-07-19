import { describe, it, expect, vi } from 'vitest';
import { createApp, type ReplicaConfig } from '../../replica/src/index.js';
import { renderMetrics, observeWriteLatency } from '../../replica/src/metrics.js';
import { NodeState } from '../../replica/src/types.js';
import type { RpcClient, TimerManager } from '../../replica/src/types.js';
import { createServer } from 'http';

function mockRpc(): RpcClient {
  return {
    requestVote: vi.fn(),
    appendEntries: vi.fn(),
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

async function requestText(app: ReturnType<typeof createApp>['app'], path: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, async () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      try {
        const res = await fetch(`http://localhost:${port}${path}`);
        const text = await res.text();
        resolve({ status: res.status, text });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe('GET /metrics', () => {
  it('exposes Raft gauges, counters, and the write-latency histogram in Prometheus text format', async () => {
    const config: ReplicaConfig = { replicaId: 'test-node', port: 0, peers: [] };
    const { app } = createApp(config, { rpcClient: mockRpc(), timerManager: mockTimers() });
    const res = await requestText(app, '/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toContain('raft_state');
    expect(res.text).toContain('raft_current_term');
    expect(res.text).toContain('raft_commit_index');
    expect(res.text).toContain('raft_elections_started_total');
    expect(res.text).toContain('raft_leadership_changes_total');
    expect(res.text).toContain('raft_write_latency_ms_bucket{le="+Inf"}');
  });
});

describe('renderMetrics / observeWriteLatency', () => {
  it('places an observation in every bucket >= its value and bumps sum/count', () => {
    observeWriteLatency(7);
    const text = renderMetrics({
      replicaId: 'x',
      state: NodeState.Follower,
      currentTerm: 0,
      leaderId: null,
      logLength: 0,
      commitIndex: 0,
      lastApplied: 0,
    });

    // 7ms falls in every bucket with le >= 7 (10, 25, 50, ...) but not le="5".
    expect(text).toMatch(/raft_write_latency_ms_bucket\{le="5"\} 0/);
    expect(text).toMatch(/raft_write_latency_ms_bucket\{le="10"\} [1-9]\d*/);
    expect(text).toMatch(/raft_write_latency_ms_count [1-9]\d*/);
    expect(text).toMatch(/raft_write_latency_ms_sum [1-9]\d*/);
  });
});

describe('GET /ready', () => {
  it('returns 503 for a fresh follower with no known leader', async () => {
    const config: ReplicaConfig = { replicaId: 'test-node', port: 0, peers: [] };
    const { app } = createApp(config, { rpcClient: mockRpc(), timerManager: mockTimers() });
    const res = await requestText(app, '/ready');
    expect(res.status).toBe(503);
  });

  it('returns 200 once the node becomes leader', async () => {
    const config: ReplicaConfig = { replicaId: 'test-node', port: 0, peers: [] };
    const { app, raftNode } = createApp(config, { rpcClient: mockRpc(), timerManager: mockTimers() });
    raftNode.becomeCandidate();
    raftNode.becomeLeader();
    const res = await requestText(app, '/ready');
    expect(res.status).toBe(200);
  });
});
