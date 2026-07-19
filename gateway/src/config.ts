// Single source of truth for gateway tunables (CLAUDE.md §6: no scattered magic numbers).
// Env-derived identity/config plus the write-path timing/retry knobs.

export interface GatewayConfig {
  port: number;
  raftPeers: string[];
  maxUsersPerBoard: number;
  // L6: shared bearer token for gateway WS/HTTP admission. null = auth disabled (local dev;
  // deploy sets AUTH_TOKEN). The one secret this project introduces (CLAUDE.md §4).
  authToken: string | null;
  // L6: CORS allowlist. '*' is an explicit opt-out, kept for local/demo flexibility.
  allowedOrigins: string[];
}

export function parseGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const port = parseInt(env.PORT ?? '8080', 10);
  const raftPeers = (env.RAFT_PEERS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const maxUsersPerBoard = parseInt(env.MAX_USERS_PER_BOARD ?? '50', 10);
  const authToken = env.AUTH_TOKEN && env.AUTH_TOKEN.length > 0 ? env.AUTH_TOKEN : null;
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return { port, raftPeers, maxUsersPerBoard, authToken, allowedOrigins };
}

// Write path to the Raft leader: bounded per-RPC timeout, plus capped exponential-backoff
// retry across peers while the leader is unknown or changing.
export const GATEWAY_TIMING = {
  rpcTimeoutMs: 3000,
  maxWriteAttempts: 5,
  writeRetryBaseDelayMs: 120,
  writeRetryMaxDelayMs: 1200,
} as const;

// L6: input-validation bounds and per-connection rate limit on the public write path.
export const GATEWAY_SECURITY = {
  maxWsPayloadBytes: 64 * 1024,
  maxStrokePoints: 2000,
  strokeRateLimitPerSec: 60,
  rateLimitWindowMs: 1000,
} as const;
