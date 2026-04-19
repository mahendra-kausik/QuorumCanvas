import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from '../../gateway/src/messageHandler.js';
import { BoardManager } from '../../gateway/src/boardManager.js';
import { LocalRaftClient } from '../../gateway/src/raftClient.js';
import type WebSocket from 'ws';
import type { Stroke } from '../../gateway/src/types.js';
import type { RaftClient } from '../../gateway/src/raftClient.js';

function mockWs(): WebSocket {
  return {
    readyState: 1,
    OPEN: 1,
    send: vi.fn(),
  } as unknown as WebSocket;
}

function makeStroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: 'stroke-1',
    boardId: 'board-1',
    userId: 'user-1',
    color: '#E74C3C',
    width: 3,
    points: [[0, 0], [10, 10]],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('MessageHandler', () => {
  let bm: BoardManager;
  let handler: MessageHandler;
  let ws: WebSocket;
  const connInfo = { boardId: 'board-1', userId: 'user-1' };

  beforeEach(() => {
    bm = new BoardManager();
    handler = new MessageHandler(bm, new LocalRaftClient(bm));
    ws = mockWs();
  });

  it('sends error on invalid JSON', async () => {
    await handler.handleMessage(ws, 'not json', connInfo);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
  });

  it('sends error on missing message type', async () => {
    await handler.handleMessage(ws, '{}', connInfo);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Missing message type' }));
  });

  it('sends error on unknown message type', async () => {
    await handler.handleMessage(ws, '{"type":"foo"}', connInfo);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Unknown message type: foo' }));
  });

  it('handles join message — sends join_ack and broadcasts user_joined', async () => {
    // Add another user first so we can verify broadcast
    const ws2 = mockWs();
    bm.joinBoard('board-1', 'user-2', ws2);

    await handler.handleMessage(ws, JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-1' }), connInfo);

    // Should send join_ack to joiner
    const joinAck = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(joinAck.type).toBe('join_ack');
    expect(joinAck.boardId).toBe('board-1');
    expect(joinAck.strokes).toEqual([]);

    // Should broadcast user_joined to others
    const userJoined = JSON.parse((ws2.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(userJoined.type).toBe('user_joined');
    expect(userJoined.userId).toBe('user-1');
  });

  it('handles join with existing strokes', async () => {
    const stroke = makeStroke();
    bm.getOrCreateBoard('board-1').strokes.push(stroke);

    await handler.handleMessage(ws, JSON.stringify({ type: 'join', boardId: 'board-1', userId: 'user-1' }), connInfo);

    const joinAck = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(joinAck.strokes).toHaveLength(1);
    expect(joinAck.strokes[0].id).toBe('stroke-1');
  });

  it('handles stroke message — stores and broadcasts', async () => {
    const ws2 = mockWs();
    bm.joinBoard('board-1', 'user-1', ws);
    bm.joinBoard('board-1', 'user-2', ws2);

    const stroke = makeStroke();
    await handler.handleMessage(ws, JSON.stringify({ type: 'stroke', stroke }), connInfo);

    // Stroke should be stored
    expect(bm.getStrokes('board-1')).toHaveLength(1);

    // Should broadcast to user-2, not to sender (user-1)
    expect(ws2.send).toHaveBeenCalled();
    const broadcast = JSON.parse((ws2.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(broadcast.type).toBe('stroke_broadcast');
    expect(broadcast.stroke.id).toBe('stroke-1');
  });

  it('handles stroke with missing data', async () => {
    await handler.handleMessage(ws, JSON.stringify({ type: 'stroke', stroke: null }), connInfo);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Invalid stroke data' }));
  });

  it('returns structured error on RAFT write failure', async () => {
    const failingRaftClient: RaftClient = {
      submitStroke: vi.fn().mockResolvedValue(false),
      getStrokes: vi.fn().mockResolvedValue([]),
    };
    handler = new MessageHandler(bm, failingRaftClient);

    const stroke = makeStroke({ id: 'stroke-fail' });
    await handler.handleMessage(ws, JSON.stringify({ type: 'stroke', stroke }), connInfo);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      message: 'Failed to submit stroke',
      code: 'RAFT_WRITE_FAILED',
      strokeId: 'stroke-fail',
      retryable: true,
    }));
  });
});
