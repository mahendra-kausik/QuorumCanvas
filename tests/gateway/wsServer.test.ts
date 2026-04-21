import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { createWsServer } from '../../gateway/src/wsServer.js';

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
    } else {
      ws.once('open', resolve);
    }
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', resolve);
  });
}

describe('WebSocket Server', () => {
  let server: Server;
  let port: number;
  const clients: WebSocket[] = [];

  function startServer(): Promise<void> {
    return new Promise((resolve) => {
      server = createServer();
      createWsServer(server);
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  function connect(boardId: string, userId: string): WebSocket {
    const ws = new WebSocket(`ws://localhost:${port}/ws?boardId=${boardId}&userId=${userId}`);
    clients.push(ws);
    return ws;
  }

  afterEach(async () => {
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN || c.readyState === WebSocket.CONNECTING) {
        c.close();
      }
    }
    clients.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects connections without boardId or userId', async () => {
    await startServer();
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    clients.push(ws);
    const msg = await waitForMessage(ws);
    expect(JSON.parse(msg)).toEqual({ type: 'error', message: 'Missing boardId or userId query parameter' });
    await waitForClose(ws);
  });

  it('accepts connection and handles join flow', async () => {
    await startServer();
    const ws = connect('board-1', 'user-1');
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-1' }));
    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('join_ack');
    expect(parsed.boardId).toBe('board-1');
    expect(parsed.strokes).toEqual([]);
  });

  it('broadcasts strokes between users', async () => {
    await startServer();

    // User 1 joins
    const ws1 = connect('board-1', 'user-1');
    await waitForOpen(ws1);
    ws1.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-1' }));
    await waitForMessage(ws1); // join_ack

    // User 2 joins
    const ws2 = connect('board-1', 'user-2');
    await waitForOpen(ws2);

    // User 1 should get user_joined for user-2
    const user2JoinedPromise = waitForMessage(ws1);
    ws2.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-2' }));
    await waitForMessage(ws2); // join_ack for user-2
    const userJoined = JSON.parse(await user2JoinedPromise);
    expect(userJoined.type).toBe('user_joined');
    expect(userJoined.userId).toBe('user-2');

    // User 1 sends a stroke — user 2 should receive it
    const strokeBroadcastPromise = waitForMessage(ws2);
    ws1.send(JSON.stringify({
      type: 'stroke',
      stroke: {
        id: 's1',
        boardId: 'board-1',
        userId: 'user-1',
        color: '#E74C3C',
        width: 3,
        points: [[0, 0], [10, 10]],
        timestamp: Date.now(),
      },
    }));
    const broadcast = JSON.parse(await strokeBroadcastPromise);
    expect(broadcast.type).toBe('stroke_broadcast');
    expect(broadcast.stroke.id).toBe('s1');
  });

  it('broadcasts strokes between tabs of the same user', async () => {
    await startServer();

    const ws1 = connect('board-1', 'user-1');
    await waitForOpen(ws1);
    ws1.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-1' }));
    await waitForMessage(ws1); // join_ack

    const ws2 = connect('board-1', 'user-1');
    await waitForOpen(ws2);
    ws2.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-1' }));
    await waitForMessage(ws2); // join_ack

    const sameUserBroadcastPromise = waitForMessage(ws2);

    ws1.send(JSON.stringify({
      type: 'stroke',
      stroke: {
        id: 'same-user-s1',
        boardId: 'board-1',
        userId: 'user-1',
        color: '#E74C3C',
        width: 3,
        points: [[0, 0], [10, 10]],
        timestamp: Date.now(),
      },
    }));

    const broadcast = JSON.parse(await sameUserBroadcastPromise);
    expect(broadcast.type).toBe('stroke_broadcast');
    expect(broadcast.stroke.id).toBe('same-user-s1');
  });

  it('broadcasts user_left on disconnect', async () => {
    await startServer();

    const ws1 = connect('board-1', 'user-1');
    await waitForOpen(ws1);
    ws1.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-1' }));
    await waitForMessage(ws1); // join_ack

    const ws2 = connect('board-1', 'user-2');
    await waitForOpen(ws2);
    ws2.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-2' }));
    await waitForMessage(ws2); // join_ack
    await waitForMessage(ws1); // user_joined for user-2

    // User 2 disconnects
    const leftPromise = waitForMessage(ws1);
    ws2.close();
    const left = JSON.parse(await leftPromise);
    expect(left.type).toBe('user_left');
    expect(left.userId).toBe('user-2');
  });

  it('second user gets existing strokes on join', async () => {
    await startServer();

    // User 1 joins and sends a stroke
    const ws1 = connect('board-1', 'user-1');
    await waitForOpen(ws1);
    ws1.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-1' }));
    await waitForMessage(ws1); // join_ack

    ws1.send(JSON.stringify({
      type: 'stroke',
      stroke: {
        id: 's1',
        boardId: 'board-1',
        userId: 'user-1',
        color: '#E74C3C',
        width: 3,
        points: [[0, 0], [10, 10]],
        timestamp: Date.now(),
      },
    }));

    // Small delay to ensure stroke is processed
    await new Promise((r) => setTimeout(r, 50));

    // User 2 joins — should get the stroke in join_ack
    const ws2 = connect('board-1', 'user-2');
    await waitForOpen(ws2);
    ws2.send(JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-2' }));
    const msg = await waitForMessage(ws2);
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('join_ack');
    expect(parsed.strokes).toHaveLength(1);
    expect(parsed.strokes[0].id).toBe('s1');
  });
});
