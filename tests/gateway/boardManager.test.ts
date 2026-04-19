import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BoardManager } from '../../gateway/src/boardManager.js';
import type { Stroke } from '../../gateway/src/types.js';
import type WebSocket from 'ws';

function mockWs(readyState = 1): WebSocket {
  const ws = {
    readyState,
    OPEN: 1,
    send: vi.fn(),
  } as unknown as WebSocket;
  return ws;
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

describe('BoardManager', () => {
  let bm: BoardManager;

  beforeEach(() => {
    bm = new BoardManager();
  });

  it('creates a board lazily on getOrCreateBoard', () => {
    expect(bm.getBoardCount()).toBe(0);
    const board = bm.getOrCreateBoard('board-1');
    expect(board.boardId).toBe('board-1');
    expect(board.strokes).toEqual([]);
    expect(board.users.size).toBe(0);
    expect(bm.getBoardCount()).toBe(1);
  });

  it('returns the same board on repeated calls', () => {
    const b1 = bm.getOrCreateBoard('board-1');
    const b2 = bm.getOrCreateBoard('board-1');
    expect(b1).toBe(b2);
  });

  it('returns undefined for non-existent board', () => {
    expect(bm.getBoard('nope')).toBeUndefined();
  });

  it('joins a user to a board and returns existing strokes', () => {
    const ws = mockWs();
    const stroke = makeStroke();
    bm.getOrCreateBoard('board-1').strokes.push(stroke);

    const strokes = bm.joinBoard('board-1', 'user-1', ws);
    expect(strokes).toEqual([stroke]);
    expect(bm.getUserCount('board-1')).toBe(1);
  });

  it('removes a user on leaveBoard', () => {
    const ws = mockWs();
    bm.joinBoard('board-1', 'user-1', ws);
    expect(bm.getUserCount('board-1')).toBe(1);
    bm.leaveBoard('board-1', 'user-1');
    expect(bm.getUserCount('board-1')).toBe(0);
  });

  it('leaveBoard is a no-op for non-existent board', () => {
    expect(() => bm.leaveBoard('nope', 'user-1')).not.toThrow();
  });

  it('adds strokes to a board', () => {
    bm.getOrCreateBoard('board-1');
    const stroke = makeStroke();
    bm.addStroke('board-1', stroke);
    expect(bm.getStrokes('board-1')).toEqual([stroke]);
  });

  it('applies undo and redo compensation events', () => {
    bm.getOrCreateBoard('board-1');
    const stroke = makeStroke({ id: 's1' });
    bm.addStroke('board-1', stroke);
    expect(bm.getStrokes('board-1').map((s) => s.id)).toEqual(['s1']);

    bm.addStroke('board-1', makeStroke({
      id: 'u1',
      action: 'undo_stroke',
      targetStrokeId: 's1',
      points: [],
      width: 0,
    }));
    expect(bm.getStrokes('board-1')).toEqual([]);

    bm.addStroke('board-1', makeStroke({
      id: 'r1',
      action: 'redo_stroke',
      targetStrokeId: 's1',
      points: [],
      width: 0,
    }));
    expect(bm.getStrokes('board-1').map((s) => s.id)).toEqual(['s1']);
  });

  it('getStrokes returns empty array for non-existent board', () => {
    expect(bm.getStrokes('nope')).toEqual([]);
  });

  it('broadcasts to all users except excluded', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    const ws3 = mockWs();
    bm.joinBoard('board-1', 'user-1', ws1);
    bm.joinBoard('board-1', 'user-2', ws2);
    bm.joinBoard('board-1', 'user-3', ws3);

    bm.broadcast('board-1', { type: 'user_joined', userId: 'user-1' }, 'user-1');

    expect(ws1.send).not.toHaveBeenCalled();
    expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'user_joined', userId: 'user-1' }));
    expect(ws3.send).toHaveBeenCalledWith(JSON.stringify({ type: 'user_joined', userId: 'user-1' }));
  });

  it('broadcasts to all users when no exclusion', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    bm.joinBoard('board-1', 'user-1', ws1);
    bm.joinBoard('board-1', 'user-2', ws2);

    bm.broadcast('board-1', { type: 'user_left', userId: 'user-3' });

    expect(ws1.send).toHaveBeenCalled();
    expect(ws2.send).toHaveBeenCalled();
  });

  it('skips closed connections during broadcast', () => {
    const wsOpen = mockWs(1);
    const wsClosed = mockWs(3); // CLOSED = 3
    bm.joinBoard('board-1', 'user-1', wsOpen);
    bm.joinBoard('board-1', 'user-2', wsClosed);

    bm.broadcast('board-1', { type: 'user_left', userId: 'user-3' });

    expect(wsOpen.send).toHaveBeenCalled();
    expect(wsClosed.send).not.toHaveBeenCalled();
  });

  it('sendTo sends to an open connection', () => {
    const ws = mockWs();
    bm.sendTo(ws, { type: 'error', message: 'test' });
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'test' }));
  });

  it('sendTo skips closed connections', () => {
    const ws = mockWs(3);
    bm.sendTo(ws, { type: 'error', message: 'test' });
    expect(ws.send).not.toHaveBeenCalled();
  });
});
