import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { createApp, type ReplicaConfig } from '../../replica/src/index.js';
import { RaftNode } from '../../replica/src/raftNode.js';
import { NodeState, type Stroke } from '../../replica/src/types.js';

function makeStroke(id: string, boardId = 'board-1'): Stroke {
  return { id, boardId, userId: 'u1', color: '#f00', width: 3, points: [[0, 0], [10, 10]], timestamp: Date.now() };
}

interface TestReplica {
  id: string;
  port: number;
  url: string;
  node: RaftNode;
  server: Server;
  stopped: boolean;
}

// Track used ports across tests to avoid collisions
let nextPort = 19001;

async function createReplica(id: string, peerUrls: string[]): Promise<TestReplica> {
  const port = nextPort++;
  const config: ReplicaConfig = { replicaId: id, port, peers: peerUrls };
  const { app, raftNode } = createApp(config);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(port, resolve));

  return { id, port, url: `http://localhost:${port}`, node: raftNode, server, stopped: false };
}

async function stopReplica(replica: TestReplica): Promise<void> {
  if (replica.stopped) return;
  replica.stopped = true;
  replica.node.stop();
  await new Promise<void>((resolve) => replica.server.close(() => resolve()));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLeader(replicas: TestReplica[], timeoutMs = 5000): Promise<TestReplica> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const leader = replicas.find((r) => !r.stopped && r.node.state === NodeState.Leader);
    if (leader) return leader;
    await wait(50);
  }
  throw new Error('No leader elected within timeout');
}

describe('RAFT Integration', () => {
  let replicas: TestReplica[] = [];

  async function startCluster(replicaCount = 3): Promise<TestReplica[]> {
    const basePort = nextPort;
    nextPort += replicaCount;
    const ids = Array.from({ length: replicaCount }, (_, i) => `node-${i + 1}`);
    const ports = Array.from({ length: replicaCount }, (_, i) => basePort + i);
    const urls = ports.map((p) => `http://localhost:${p}`);

    replicas = [];
    for (let i = 0; i < replicaCount; i++) {
      const peers = urls.filter((_, j) => j !== i);
      const config: ReplicaConfig = { replicaId: ids[i], port: ports[i], peers };
      const { app, raftNode } = createApp(config);
      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(ports[i], resolve));
      replicas.push({ id: ids[i], port: ports[i], url: urls[i], node: raftNode, server, stopped: false });
    }

    for (const r of replicas) r.node.start();
    return replicas;
  }

  afterEach(async () => {
    for (const r of replicas) {
      try { await stopReplica(r); } catch { /* already stopped */ }
    }
    replicas = [];
  });

  it('elects a leader on startup', async () => {
    await startCluster();
    const leader = await waitForLeader(replicas);
    expect(leader.node.state).toBe(NodeState.Leader);

    // Wait for heartbeats to settle remaining nodes
    await wait(300);
    const followers = replicas.filter((r) => r.id !== leader.id);
    for (const f of followers) {
      expect(f.node.state).toBe(NodeState.Follower);
    }
  }, 10000);

  it('replicates a stroke to all nodes', async () => {
    await startCluster();
    const leader = await waitForLeader(replicas);

    const result = await leader.node.handleClientWrite(makeStroke('s1'));
    expect(result.success).toBe(true);
    expect(leader.node.commitIndex).toBe(1);

    // Wait for followers to apply via heartbeat
    await wait(500);

    for (const r of replicas) {
      expect(r.node.log.getLength()).toBeGreaterThanOrEqual(1);
    }
  }, 10000);

  it('elects a new leader after leader crash', async () => {
    await startCluster();
    const oldLeader = await waitForLeader(replicas);
    const oldLeaderId = oldLeader.id;

    await stopReplica(oldLeader);

    // Remaining replicas should elect a new leader within election timeout
    const start = Date.now();
    let newLeader: TestReplica | undefined;
    while (Date.now() - start < 5000) {
      newLeader = replicas.find((r) => !r.stopped && r.node.state === NodeState.Leader);
      if (newLeader) break;
      await wait(50);
    }

    expect(newLeader).toBeDefined();
    expect(newLeader!.id).not.toBe(oldLeaderId);
  }, 10000);

  it('new leader accepts writes after failover', async () => {
    await startCluster();
    const oldLeader = await waitForLeader(replicas);

    await oldLeader.node.handleClientWrite(makeStroke('s1'));
    await stopReplica(oldLeader);

    // Wait for new leader
    const start = Date.now();
    let newLeader: TestReplica | undefined;
    while (Date.now() - start < 5000) {
      newLeader = replicas.find((r) => !r.stopped && r.node.state === NodeState.Leader);
      if (newLeader) break;
      await wait(50);
    }
    expect(newLeader).toBeDefined();

    const result = await newLeader!.node.handleClientWrite(makeStroke('s2'));
    expect(result.success).toBe(true);
  }, 15000);

  it('requires majority of 3 in a 4-replica cluster', async () => {
    await startCluster(4);
    const leader = await waitForLeader(replicas);

    await wait(300);
    const followers = replicas.filter((r) => !r.stopped && r.id !== leader.id);
    await stopReplica(followers[0]);

    const withThreeAlive = await leader.node.handleClientWrite(makeStroke('s-majority-ok'));
    expect(withThreeAlive.success).toBe(true);

    await stopReplica(followers[1]);
    await wait(200);

    const withTwoAlive = await leader.node.handleClientWrite(makeStroke('s-majority-fail'));
    expect(withTwoAlive.success).toBe(false);
  }, 15000);

  it('restarted node catches up via sync-log', async () => {
    await startCluster();
    const leader = await waitForLeader(replicas);

    // Write strokes
    await leader.node.handleClientWrite(makeStroke('s1'));
    await leader.node.handleClientWrite(makeStroke('s2'));
    await leader.node.handleClientWrite(makeStroke('s3'));
    await wait(300); // let replication settle

    // Pick a follower and kill it
    const follower = replicas.find((r) => r.id !== leader.id)!;
    const followerIdx = replicas.indexOf(follower);
    await stopReplica(follower);

    // Write more while follower is down (2 nodes remain, majority = 2, so the
    // remaining follower must ack for commit. Give heartbeat time to replicate.)
    const r4 = await leader.node.handleClientWrite(makeStroke('s4'));
    const r5 = await leader.node.handleClientWrite(makeStroke('s5'));
    expect(r4.success).toBe(true);
    expect(r5.success).toBe(true);

    // Restart follower — use same peers as the leader so it can reach the leader
    const newPort = nextPort++;
    const peers = replicas.filter((r) => !r.stopped).map((r) => r.url);

    const config: ReplicaConfig = { replicaId: follower.id, port: newPort, peers };
    const { app, raftNode: newNode } = createApp(config);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(newPort, resolve));
    const restarted: TestReplica = { id: follower.id, port: newPort, url: `http://localhost:${newPort}`, node: newNode, server, stopped: false };
    replicas[followerIdx] = restarted;

    // Catch up from leader
    restarted.node.leaderId = leader.url;
    await restarted.node.requestCatchUp();

    expect(restarted.node.log.getLength()).toBe(5);
    expect(restarted.node.commitIndex).toBe(5);
    expect(restarted.node.getStrokes('board-1')).toHaveLength(5);
  }, 15000);

  it('follower rejects writes with leader hint', async () => {
    await startCluster();
    await waitForLeader(replicas);

    // Wait for heartbeats so followers know the leader
    await wait(300);

    const follower = replicas.find((r) => r.node.state === NodeState.Follower)!;
    const result = await follower.node.handleClientWrite(makeStroke('s1'));
    expect(result.success).toBe(false);
    expect(result.leaderHint).toBeDefined();
  }, 10000);

  it('stale leader steps down on higher term', async () => {
    await startCluster();
    const leader = await waitForLeader(replicas);

    leader.node.handleHeartbeat({
      term: leader.node.currentTerm + 10,
      leaderId: 'external-leader',
      leaderCommit: 0,
    });

    expect(leader.node.state).toBe(NodeState.Follower);
  }, 10000);
});
