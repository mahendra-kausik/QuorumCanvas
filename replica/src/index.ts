import express from 'express';
import { setReplicaId, log } from './logger.js';
import { RaftNode } from './raftNode.js';
import { DefaultTimerManager } from './electionTimer.js';
import { HttpRpcClient } from './rpcClient.js';
import { createRpcRouter } from './rpcHandlers.js';
import type { RpcClient, TimerManager } from './types.js';

export interface ReplicaConfig {
  replicaId: string;
  port: number;
  peers: string[];
}

export function parseConfig(env: Record<string, string | undefined>): ReplicaConfig {
  const replicaId = env.REPLICA_ID;
  if (!replicaId) throw new Error('REPLICA_ID environment variable is required');

  const port = parseInt(env.PORT ?? '3001', 10);
  if (isNaN(port)) throw new Error('PORT must be a number');

  const peersStr = env.PEERS ?? '';
  const peers = peersStr ? peersStr.split(',').map((p) => p.trim()) : [];

  return { replicaId, port, peers };
}

export function createApp(config: ReplicaConfig, deps?: { rpcClient?: RpcClient; timerManager?: TimerManager }) {
  const app = express();
  app.use(express.json());

  const rpcClient = deps?.rpcClient ?? new HttpRpcClient();
  const timerManager = deps?.timerManager ?? new DefaultTimerManager({ replicaId: config.replicaId });
  const raftNode = new RaftNode(config.replicaId, config.peers, rpcClient, timerManager);

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
    setTimeout(() => raftNode.requestCatchUp(), 1000);
  });
}
