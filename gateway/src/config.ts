// Single source of truth for gateway tunables (CLAUDE.md §6: no scattered magic numbers).
// Env-derived identity/config plus the write-path timing/retry knobs.

export interface GatewayConfig {
  port: number;
  raftPeers: string[];
  maxUsersPerBoard: number;
}

export function parseGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const port = parseInt(env.PORT ?? '8080', 10);
  const raftPeers = (env.RAFT_PEERS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const maxUsersPerBoard = parseInt(env.MAX_USERS_PER_BOARD ?? '50', 10);
  return { port, raftPeers, maxUsersPerBoard };
}

// Write path to the Raft leader: bounded per-RPC timeout, plus capped exponential-backoff
// retry across peers while the leader is unknown or changing.
export const GATEWAY_TIMING = {
  rpcTimeoutMs: 3000,
  maxWriteAttempts: 5,
  writeRetryBaseDelayMs: 120,
  writeRetryMaxDelayMs: 1200,
} as const;
