import express from 'express';
import { setReplicaId, log } from './logger.js';
import { RaftNode } from './raftNode.js';
import { DefaultTimerManager } from './electionTimer.js';
import { HttpRpcClient } from './rpcClient.js';
import { createRpcRouter } from './rpcHandlers.js';
import { parseConfig, RAFT_TIMING, type ReplicaConfig } from './config.js';
import { FilePersistence, MemoryPersistence } from './persistence.js';
import type { RpcClient, TimerManager } from './types.js';

// Re-exported for callers/tests that import config from the service entrypoint.
export { parseConfig, type ReplicaConfig };

export function createApp(config: ReplicaConfig, deps?: { rpcClient?: RpcClient; timerManager?: TimerManager }) {
  const app = express();
  app.use(express.json());

  const rpcClient = deps?.rpcClient ?? new HttpRpcClient();
  const timerManager = deps?.timerManager ?? new DefaultTimerManager({ replicaId: config.replicaId });
  // Replay (term/vote/commitIndex + WAL) happens synchronously inside the RaftNode
  // constructor, before this replica can vote, be elected, or serve traffic.
  const persistence = config.dataDir ? new FilePersistence(config.dataDir) : new MemoryPersistence();
  const raftNode = new RaftNode(
    config.replicaId,
    config.peers,
    rpcClient,
    timerManager,
    persistence,
    config.snapshotThresholdEntries ?? RAFT_TIMING.snapshotThresholdEntries,
    config.advertisedUrl ?? `http://${config.replicaId}:${config.port}`,
    config.appendEntriesBatchCap ?? RAFT_TIMING.appendEntriesBatchCap,
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', replicaId: config.replicaId });
  });

  // Liveness (/health) vs readiness (/ready): /health only proves the process is up;
  // /ready proves this node has joined a functioning cluster (leader, or a follower that has
  // heard from one) — see RaftNode.isReady() for the exact definition.
  app.get('/ready', (_req, res) => {
    const status = raftNode.getStatus();
    const ready = raftNode.isReady();
    res.status(ready ? 200 : 503).json({ ready, state: status.state, leaderId: status.leaderId });
  });

  app.use(createRpcRouter(raftNode));

  return { app, raftNode };
}

// Only start server when run directly (not imported by tests)
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  const config = parseConfig(process.env);
  setReplicaId(config.replicaId);

  const { app, raftNode } = createApp(config);
  const server = app.listen(config.port, () => {
    log('info', 'server_start', { port: config.port, peers: config.peers });
    raftNode.start();

    // Attempt catch-up after a short delay to allow cluster to stabilize
    setTimeout(() => raftNode.requestCatchUp(), RAFT_TIMING.catchUpDelayMs);
  });

  // Graceful shutdown (L5): stop the Raft timers so no election/heartbeat fires mid-teardown,
  // then close the HTTP server. WAL entries and state.json are fsynced on every mutation (L1),
  // so there is no in-memory buffer to flush here — persistState()/log.append() already did it.
  const shutdown = (signal: string) => {
    log('info', 'shutdown', { signal });
    raftNode.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
