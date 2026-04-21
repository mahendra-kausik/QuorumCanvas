import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { collectClusterStatus } from '../../gateway/src/clusterStatus.js';

function createMockReplica(
  handler: (req: { method: string; url: string }) => { status: number; body: unknown },
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const result = handler({ method: req.method ?? 'GET', url: req.url ?? '/' });
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

describe('collectClusterStatus', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

  it('aggregates replica health and status', async () => {
    const { server: s1, url: u1 } = await createMockReplica(({ url }) => {
      if (url === '/health') return { status: 200, body: { status: 'ok', replicaId: 'replica1' } };
      if (url === '/status') {
        return {
          status: 200,
          body: {
            replicaId: 'replica1',
            state: 'leader',
            currentTerm: 3,
            leaderId: 'replica1',
            logLength: 8,
            commitIndex: 8,
            lastApplied: 8,
          },
        };
      }
      return { status: 404, body: {} };
    });

    const { server: s2, url: u2 } = await createMockReplica(({ url }) => {
      if (url === '/health') return { status: 200, body: { status: 'ok', replicaId: 'replica2' } };
      if (url === '/status') {
        return {
          status: 200,
          body: {
            replicaId: 'replica2',
            state: 'follower',
            currentTerm: 3,
            leaderId: 'replica1',
            logLength: 8,
            commitIndex: 8,
            lastApplied: 8,
          },
        };
      }
      return { status: 404, body: {} };
    });

    servers.push(s1, s2);

    const result = await collectClusterStatus([u1, u2]);
    expect(result.totalReplicas).toBe(2);
    expect(result.majority).toBe(2);
    expect(result.healthyReplicas).toBe(2);
    expect(result.leaderReplicaId).toBe('replica1');
    expect(result.leaderCount).toBe(1);
    expect(result.replicas).toHaveLength(2);
  });

  it('marks unreachable replicas as unhealthy', async () => {
    const result = await collectClusterStatus(['http://localhost:1']);
    expect(result.totalReplicas).toBe(1);
    expect(result.healthyReplicas).toBe(0);
    expect(result.leaderReplicaId).toBeNull();
    expect(result.replicas[0].healthy).toBe(false);
    expect(result.replicas[0].error).toBeTruthy();
  });
});
