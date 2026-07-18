// Single source of truth for replica tunables (CLAUDE.md §6: no scattered magic numbers).
// Identity config (id/port/peers) is parsed per-instance from the environment; Raft timing
// knobs are centralized here so benchmark ablations and interview defense are trivial.

export interface ReplicaConfig {
  replicaId: string;
  port: number;
  peers: string[];
  // Directory for the WAL + state.json (L1 durability). Unset → in-memory only (e.g. tests).
  dataDir?: string;
}

export function parseConfig(env: Record<string, string | undefined>): ReplicaConfig {
  const replicaId = env.REPLICA_ID;
  if (!replicaId) throw new Error('REPLICA_ID environment variable is required');

  const port = parseInt(env.PORT ?? '3001', 10);
  if (isNaN(port)) throw new Error('PORT must be a number');

  const peersStr = env.PEERS ?? '';
  const peers = peersStr ? peersStr.split(',').map((p) => p.trim()) : [];

  const dataDir = env.DATA_DIR || undefined;

  return { replicaId, port, peers, dataDir };
}

// Raft timing, milliseconds. The election-timeout window must sit well above the heartbeat
// interval so a live leader's heartbeats reliably pre-empt follower election timers
// (Raft paper §5.2). Randomizing within the window avoids repeated split votes.
export const RAFT_TIMING = {
  electionTimeoutMinMs: 500,
  electionTimeoutMaxMs: 800,
  heartbeatIntervalMs: 150,
  // Deterministic per-replica skew (replicaNumber * step) added to the randomized election
  // timeout, further reducing split votes when all nodes restart together with aligned clocks.
  electionSkewStepMs: 300,
  // Abort a peer RPC that has not responded within this budget.
  rpcTimeoutMs: 2000,
  // Delay before a freshly started node asks the cluster for catch-up, letting it stabilize.
  catchUpDelayMs: 1000,
} as const;
