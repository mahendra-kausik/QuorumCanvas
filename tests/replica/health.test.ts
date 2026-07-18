import { describe, it, expect } from 'vitest';
import { createApp, parseConfig, type ReplicaConfig } from '../../replica/src/index.js';

// Lightweight supertest-like helper using native fetch
async function request(app: ReturnType<typeof createApp>['app'], method: string, path: string) {
  const { createServer } = await import('http');
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, async () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      try {
        const res = await fetch(`http://localhost:${port}${path}`, { method });
        const body = await res.json() as Record<string, unknown>;
        resolve({ status: res.status, body });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe('parseConfig', () => {
  it('parses valid environment variables', () => {
    const config = parseConfig({
      REPLICA_ID: 'replica1',
      PORT: '3001',
      PEERS: 'http://replica2:3002,http://replica3:3003',
    });
    expect(config).toEqual({
      replicaId: 'replica1',
      port: 3001,
      peers: ['http://replica2:3002', 'http://replica3:3003'],
      dataDir: undefined,
      snapshotThresholdEntries: undefined,
      advertisedUrl: 'http://replica1:3001',
    });
  });

  it('uses default port 3001 when PORT is not set', () => {
    const config = parseConfig({ REPLICA_ID: 'replica1' });
    expect(config.port).toBe(3001);
  });

  it('handles empty PEERS', () => {
    const config = parseConfig({ REPLICA_ID: 'replica1' });
    expect(config.peers).toEqual([]);
  });

  it('throws when REPLICA_ID is missing', () => {
    expect(() => parseConfig({})).toThrow('REPLICA_ID');
  });
});

describe('GET /health', () => {
  it('returns ok status with replica id', async () => {
    const config: ReplicaConfig = { replicaId: 'test-replica', port: 0, peers: [] };
    const { app } = createApp(config);
    const res = await request(app, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', replicaId: 'test-replica' });
  });
});
