import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { GATEWAY_HTTP_URL } from '../constants';

interface ReplicaClusterStatus {
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

interface ClusterStatusResponse {
  generatedAt: string;
  totalReplicas: number;
  healthyReplicas: number;
  majority: number;
  leaderReplicaId: string | null;
  leaderCount: number;
  replicas: ReplicaClusterStatus[];
}

export function Dashboard() {
  const [data, setData] = useState<ClusterStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const response = await fetch(`${GATEWAY_HTTP_URL}/cluster-status`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const parsed = (await response.json()) as ClusterStatusResponse;
        if (!cancelled) {
          setData(parsed);
          setError(null);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setError(message);
        }
      }
    };

    fetchStatus().catch(() => undefined);
    const timer = setInterval(() => {
      fetchStatus().catch(() => undefined);
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const leaderLabel = useMemo(() => {
    if (!data?.leaderReplicaId) return 'No active leader';
    return `Leader: ${data.leaderReplicaId}`;
  }, [data?.leaderReplicaId]);

  return (
    <div style={{ maxWidth: 1200, margin: '24px auto', padding: '0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>RAFT Dashboard</h1>
        <Link to="/" style={{ marginLeft: 'auto' }}>Back to Home</Link>
      </div>

      <div style={{ marginTop: 16, padding: 12, border: '1px solid #ddd', borderRadius: 10, background: '#fafafa' }}>
        {error ? (
          <div style={{ color: '#c0392b' }}>Gateway status error: {error}</div>
        ) : (
          <>
            <div><strong>{leaderLabel}</strong></div>
            <div>Healthy replicas: {data?.healthyReplicas ?? 0} / {data?.totalReplicas ?? 0}</div>
            <div>Majority requirement: {data?.majority ?? 0}</div>
            <div>Leader count observed: {data?.leaderCount ?? 0}</div>
            <div>Last update: {data?.generatedAt ?? 'n/a'}</div>
          </>
        )}
      </div>

      <div style={{ marginTop: 16, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
          <thead>
            <tr>
              <th style={cellHeader}>Replica</th>
              <th style={cellHeader}>Peer URL</th>
              <th style={cellHeader}>Healthy</th>
              <th style={cellHeader}>State</th>
              <th style={cellHeader}>Term</th>
              <th style={cellHeader}>Leader Hint</th>
              <th style={cellHeader}>Commit Index</th>
              <th style={cellHeader}>Last Applied</th>
              <th style={cellHeader}>Log Length</th>
            </tr>
          </thead>
          <tbody>
            {data?.replicas?.map((replica) => (
              <tr key={replica.peer}>
                <td style={cellBody}>{replica.replicaId}</td>
                <td style={cellBody}>{replica.peer}</td>
                <td style={{ ...cellBody, color: replica.healthy ? '#1e8449' : '#c0392b' }}>
                  {replica.healthy ? 'yes' : 'no'}
                </td>
                <td style={cellBody}>{replica.state ?? '-'}</td>
                <td style={cellBody}>{replica.currentTerm ?? '-'}</td>
                <td style={cellBody}>{replica.leaderId ?? '-'}</td>
                <td style={cellBody}>{replica.commitIndex ?? '-'}</td>
                <td style={cellBody}>{replica.lastApplied ?? '-'}</td>
                <td style={cellBody}>{replica.logLength ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cellHeader: CSSProperties = {
  textAlign: 'left',
  padding: '10px 8px',
  borderBottom: '2px solid #e0e0e0',
  fontSize: 14,
};

const cellBody: CSSProperties = {
  padding: '10px 8px',
  borderBottom: '1px solid #ededed',
  fontSize: 14,
};
