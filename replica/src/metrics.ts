// Prometheus text-exposition metrics (L5 observability). Hand-rolled rather than pulling in
// prom-client: only 3 accumulated series are needed (2 counters + 1 histogram) and every gauge
// is read live from RaftNode.getStatus() at scrape time — not worth a new dependency (D16).
import type { ReplicaStatus } from './types.js';
import { NodeState } from './types.js';

// Fixed histogram buckets (ms) for committed-write latency.
const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000] as const;

let electionsStarted = 0;
let leadershipChanges = 0;
const latencyBucketCounts = new Array<number>(LATENCY_BUCKETS_MS.length).fill(0);
let latencySum = 0;
let latencyCount = 0;

export function recordElectionStarted(): void {
  electionsStarted++;
}

export function recordLeadershipChange(): void {
  leadershipChanges++;
}

export function observeWriteLatency(ms: number): void {
  latencySum += ms;
  latencyCount++;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (ms <= LATENCY_BUCKETS_MS[i]) latencyBucketCounts[i]++;
  }
}

const STATE_VALUE: Record<NodeState, number> = {
  [NodeState.Follower]: 0,
  [NodeState.Candidate]: 1,
  [NodeState.Leader]: 2,
};

export function renderMetrics(status: ReplicaStatus): string {
  const lines: string[] = [];

  lines.push('# HELP raft_state Node state (0=follower, 1=candidate, 2=leader)');
  lines.push('# TYPE raft_state gauge');
  lines.push(`raft_state ${STATE_VALUE[status.state]}`);

  lines.push('# HELP raft_current_term Current Raft term');
  lines.push('# TYPE raft_current_term gauge');
  lines.push(`raft_current_term ${status.currentTerm}`);

  lines.push('# HELP raft_commit_index Highest log index known committed');
  lines.push('# TYPE raft_commit_index gauge');
  lines.push(`raft_commit_index ${status.commitIndex}`);

  lines.push('# HELP raft_last_applied Highest log index applied to the state machine');
  lines.push('# TYPE raft_last_applied gauge');
  lines.push(`raft_last_applied ${status.lastApplied}`);

  lines.push('# HELP raft_log_length Number of entries currently held in the log');
  lines.push('# TYPE raft_log_length gauge');
  lines.push(`raft_log_length ${status.logLength}`);

  lines.push('# HELP raft_elections_started_total Elections this node has started as candidate');
  lines.push('# TYPE raft_elections_started_total counter');
  lines.push(`raft_elections_started_total ${electionsStarted}`);

  lines.push('# HELP raft_leadership_changes_total Times this node has become leader');
  lines.push('# TYPE raft_leadership_changes_total counter');
  lines.push(`raft_leadership_changes_total ${leadershipChanges}`);

  lines.push('# HELP raft_write_latency_ms Committed client-write latency in milliseconds');
  lines.push('# TYPE raft_write_latency_ms histogram');
  // latencyBucketCounts[i] is already cumulative — observeWriteLatency increments every
  // bucket whose bound is >= the observed value (standard Prometheus "le" semantics).
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    lines.push(`raft_write_latency_ms_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${latencyBucketCounts[i]}`);
  }
  lines.push(`raft_write_latency_ms_bucket{le="+Inf"} ${latencyCount}`);
  lines.push(`raft_write_latency_ms_sum ${latencySum}`);
  lines.push(`raft_write_latency_ms_count ${latencyCount}`);

  return lines.join('\n') + '\n';
}
