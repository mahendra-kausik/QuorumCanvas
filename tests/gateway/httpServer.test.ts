import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'http';
import { createGatewayServer } from '../../gateway/src/index.js';
import type { GatewayConfig } from '../../gateway/src/config.js';

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    raftPeers: [],
    maxUsersPerBoard: 50,
    authToken: null,
    allowedOrigins: ['http://localhost:5173'],
    ...overrides,
  };
}

function start(config: GatewayConfig): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const { server } = createGatewayServer(config);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

describe('gateway HTTP server (L6 auth + CORS)', () => {
  let server: Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('/health is open regardless of AUTH_TOKEN', async () => {
    ({ server } = await start(baseConfig({ authToken: 'secret' })));
    const res = await fetch(`http://localhost:${(server.address() as { port: number }).port}/health`);
    expect(res.status).toBe(200);
  });

  it('/cluster-status returns 401 without a valid bearer token when AUTH_TOKEN is set', async () => {
    const started = await start(baseConfig({ authToken: 'secret' }));
    server = started.server;
    const res = await fetch(`${started.url}/cluster-status`);
    expect(res.status).toBe(401);
  });

  it('/cluster-status returns non-401 with a valid bearer token', async () => {
    const started = await start(baseConfig({ authToken: 'secret' }));
    server = started.server;
    const res = await fetch(`${started.url}/cluster-status`, {
      headers: { Authorization: 'Bearer secret' },
    });
    // No RAFT_PEERS configured → 503, not 401 — proves auth passed.
    expect(res.status).toBe(503);
  });

  it('/cluster-status is open when AUTH_TOKEN is unset', async () => {
    const started = await start(baseConfig({ authToken: null }));
    server = started.server;
    const res = await fetch(`${started.url}/cluster-status`);
    expect(res.status).toBe(503); // reaches the RAFT_PEERS check, not blocked by auth
  });

  it('echoes an allowlisted Origin, omits the header for a disallowed one', async () => {
    const started = await start(baseConfig({ allowedOrigins: ['http://allowed.example'] }));
    server = started.server;

    const allowed = await fetch(`${started.url}/health`, { headers: { Origin: 'http://allowed.example' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://allowed.example');

    const disallowed = await fetch(`${started.url}/health`, { headers: { Origin: 'http://evil.example' } });
    expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();
  });
});
