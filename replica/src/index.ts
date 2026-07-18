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
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', replicaId: config.replicaId });
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
  app.listen(config.port, () => {
    log('info', 'server_start', { port: config.port, peers: config.peers });
    raftNode.start();

    // Attempt catch-up after a short delay to allow cluster to stabilize
    setTimeout(() => raftNode.requestCatchUp(), RAFT_TIMING.catchUpDelayMs);
  });
}
