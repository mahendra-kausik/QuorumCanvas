// Single source of truth for replica tunables (CLAUDE.md §6: no scattered magic numbers).
// Identity config (id/port/peers) is parsed per-instance from the environment; Raft timing
// knobs are centralized here so benchmark ablations and interview defense are trivial.

export interface ReplicaConfig {
  replicaId: string;
  port: number;
  peers: string[];
  // Directory for the WAL + state.json (L1 durability). Unset → in-memory only (e.g. tests).
  dataDir?: string;
  // Override RAFT_TIMING.snapshotThresholdEntries (L2). Unset → use the default.
  snapshotThresholdEntries?: number;
  // Explicit URL peers/gateway should use to reach this node as leader (L3) — replaces the
  // fragile replicaId-substring redirect. Unset → RaftNode falls back to a same-container
  // hostname guess; set ADVERTISED_URL explicitly for any other deploy topology.
  advertisedUrl?: string;
}

export function parseConfig(env: Record<string, string | undefined>): ReplicaConfig {
  const replicaId = env.REPLICA_ID;
  if (!replicaId) throw new Error('REPLICA_ID environment variable is required');

  const port = parseInt(env.PORT ?? '3001', 10);
  if (isNaN(port)) throw new Error('PORT must be a number');

  const peersStr = env.PEERS ?? '';
  const peers = peersStr ? peersStr.split(',').map((p) => p.trim()) : [];

  const dataDir = env.DATA_DIR || undefined;

  const snapshotThresholdEntries = env.SNAPSHOT_THRESHOLD
    ? parseInt(env.SNAPSHOT_THRESHOLD, 10)
    : undefined;

  const advertisedUrl = env.ADVERTISED_URL || `http://${replicaId}:${port}`;

  return { replicaId, port, peers, dataDir, snapshotThresholdEntries, advertisedUrl };
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
  // Snapshot after this many committed entries since the last snapshot (L2 log compaction).
  // Tuned against benchmarks at L8; small enough here to keep the WAL bounded on a free-tier disk.
  snapshotThresholdEntries: 500,
} as const;
