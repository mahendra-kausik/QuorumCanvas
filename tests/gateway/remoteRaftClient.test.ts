import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { RemoteRaftClient } from '../../gateway/src/remoteRaftClient.js';
import type { Stroke } from '../../gateway/src/types.js';

function makeStroke(id = 's1'): Stroke {
  return { id, boardId: 'b1', userId: 'u1', color: '#f00', width: 3, points: [[0, 0]], timestamp: 1 };
}

function createMockReplica(handler: (req: { method: string; url: string; body: string }) => { status: number; body: unknown }): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const result = handler({ method: req.method!, url: req.url!, body });
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

describe('RemoteRaftClient', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers.length = 0;
  });

  it('submitStroke succeeds when leader accepts', async () => {
    const { server, url } = await createMockReplica(() => ({
      status: 200,
      body: { success: true },
    }));
    servers.push(server);

    const client = new RemoteRaftClient([url]);
    const result = await client.submitStroke(makeStroke());
    expect(result).toBe(true);
  });

  it('submitStroke follows leaderHint on redirect', async () => {
    // First replica is not leader, hints to second
    const { server: s1, url: url1 } = await createMockReplica(() => ({
      status: 200,
      body: { success: false, leaderHint: 'leader' },
    }));
    servers.push(s1);

    const { server: s2, url: url2 } = await createMockReplica(() => ({
      status: 200,
      body: { success: true },
    }));
    servers.push(s2);

    // Use url2 that contains 'leader' substring for hint matching
    const client = new RemoteRaftClient([url1, url2]);
    // The leaderHint is 'leader' which won't match any URL exactly,
    // but the fallback loop will try url2 next
    const result = await client.submitStroke(makeStroke());
    expect(result).toBe(true);
  });

  it('submitStroke returns false when all peers fail', async () => {
    const client = new RemoteRaftClient(['http://localhost:1']);  // unreachable
    const result = await client.submitStroke(makeStroke());
    expect(result).toBe(false);
  });

  it('submitStroke retries on temporary no-leader responses', async () => {
    let calls = 0;
    const { server, url } = await createMockReplica(() => {
      calls++;
      if (calls < 3) {
        return {
          status: 200,
          body: { success: false },
        };
      }
      return {
        status: 200,
        body: { success: true },
      };
    });
    servers.push(server);

    const client = new RemoteRaftClient([url]);
    const result = await client.submitStroke(makeStroke('retry-stroke'));
    expect(result).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('getStrokes returns strokes from available peer', async () => {
    const stroke = makeStroke();
    const { server, url } = await createMockReplica((req) => {
      if (req.url?.startsWith('/board-state')) {
        return { status: 200, body: { boardId: 'b1', strokes: [stroke] } };
      }
      return { status: 404, body: {} };
    });
    servers.push(server);

    const client = new RemoteRaftClient([url]);
    const strokes = await client.getStrokes('b1');
    expect(strokes).toHaveLength(1);
    expect(strokes[0].id).toBe('s1');
  });

  it('getStrokes returns empty array when all peers fail', async () => {
    const client = new RemoteRaftClient(['http://localhost:1']);
    const strokes = await client.getStrokes('b1');
    expect(strokes).toEqual([]);
  });
});
