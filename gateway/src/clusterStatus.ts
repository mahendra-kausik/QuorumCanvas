interface ReplicaHealthResponse {
  status?: string;
  replicaId?: string;
}

interface ReplicaStatusResponse {
  replicaId: string;
  state: string;
  currentTerm: number;
  leaderId: string | null;
  logLength: number;
  commitIndex: number;
  lastApplied: number;
}

export interface ReplicaClusterStatus {
  peer: string;
  healthy: boolean;
  replicaId: string;
  state: string | null;
  currentTerm: number | null;
  leaderId: string | null;
  logLength: number | null;
  commitIndex: number | null;
  lastApplied: number | null;
  error?: string;
}

export interface ClusterStatusResponse {
  generatedAt: string;
  totalReplicas: number;
  healthyReplicas: number;
  majority: number;
  leaderReplicaId: string | null;
  leaderCount: number;
  replicas: ReplicaClusterStatus[];
}

const STATUS_TIMEOUT_MS = 1500;

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchReplicaClusterStatus(peer: string): Promise<ReplicaClusterStatus> {
  try {
    const [health, status] = await Promise.all([
      fetchJson<ReplicaHealthResponse>(`${peer}/health`, STATUS_TIMEOUT_MS),
      fetchJson<ReplicaStatusResponse>(`${peer}/status`, STATUS_TIMEOUT_MS),
    ]);

    return {
      peer,
      healthy: health.status === 'ok',
      replicaId: status.replicaId ?? health.replicaId ?? peer,
      state: status.state,
      currentTerm: status.currentTerm,
      leaderId: status.leaderId,
      logLength: status.logLength,
      commitIndex: status.commitIndex,
      lastApplied: status.lastApplied,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      peer,
      healthy: false,
      replicaId: peer,
      state: null,
      currentTerm: null,
      leaderId: null,
      logLength: null,
      commitIndex: null,
      lastApplied: null,
      error: message,
    };
  }
}

export async function collectClusterStatus(peers: string[]): Promise<ClusterStatusResponse> {
  const replicas = await Promise.all(peers.map((peer) => fetchReplicaClusterStatus(peer)));
  const leaders = replicas.filter((replica) => replica.state === 'leader');

  return {
    generatedAt: new Date().toISOString(),
    totalReplicas: peers.length,
    healthyReplicas: replicas.filter((replica) => replica.healthy).length,
    majority: Math.floor(peers.length / 2) + 1,
    leaderReplicaId: leaders[0]?.replicaId ?? null,
    leaderCount: leaders.length,
    replicas,
  };
}
