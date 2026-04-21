import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Stroke } from '../../../frontend/src/types';

// Suppress console.log from logger
vi.spyOn(console, 'log').mockImplementation(() => {});

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() { MockWebSocket.instances.push(this); }
  simulateOpen() { this.readyState = 1; this.onopen?.(new Event('open')); }
  simulateMessage(data: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) })); }
}

Object.defineProperty(globalThis, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
  configurable: true,
});

import { useBoard } from '../../../frontend/src/hooks/useBoard';

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useBoard', () => {
  it('starts with empty strokes', () => {
    const { result } = renderHook(() => useBoard({ boardId: 'abc', userId: 'user1' }));
    expect(result.current.strokes).toEqual([]);
  });

  it('populates strokes from join_ack', async () => {
    const { result } = renderHook(() => useBoard({ boardId: 'abc', userId: 'user1' }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    act(() => ws.simulateOpen());

    const existingStrokes: Stroke[] = [{
      id: 's1', boardId: 'abc', userId: 'other', color: '#3498DB',
      width: 3, points: [[0, 0], [10, 10]], timestamp: 1000,
    }];
    act(() => ws.simulateMessage({ type: 'join_ack', boardId: 'abc', strokes: existingStrokes }));

    expect(result.current.strokes).toHaveLength(1);
    expect(result.current.strokes[0].id).toBe('s1');
  });

  it('adds remote strokes from stroke_broadcast', async () => {
    const { result } = renderHook(() => useBoard({ boardId: 'abc', userId: 'user1' }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    act(() => ws.simulateOpen());

    const remoteStroke: Stroke = {
      id: 's2', boardId: 'abc', userId: 'other', color: '#2ECC71',
      width: 3, points: [[50, 50], [100, 100]], timestamp: 2000,
    };
    act(() => ws.simulateMessage({ type: 'stroke_broadcast', stroke: remoteStroke }));

    expect(result.current.strokes).toHaveLength(1);
    expect(result.current.strokes[0].id).toBe('s2');
  });

  it('adds local stroke optimistically and sends via WS', async () => {
    const { result } = renderHook(() => useBoard({ boardId: 'abc', userId: 'user1' }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    act(() => ws.simulateOpen());
    ws.send.mockClear();

    const stroke: Stroke = {
      id: 's3', boardId: 'abc', userId: 'user1', color: '#E74C3C',
      width: 3, points: [[0, 0], [20, 20]], timestamp: 3000,
    };
    act(() => result.current.addStroke(stroke));

    expect(result.current.strokes).toHaveLength(1);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'stroke', stroke }));
  });

  it('tracks user presence from user_joined and user_left', async () => {
    const { result } = renderHook(() => useBoard({ boardId: 'abc', userId: 'user1' }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    act(() => ws.simulateOpen());

    act(() => ws.simulateMessage({ type: 'user_joined', userId: 'user2' }));
    expect(result.current.users).toContain('user2');

    act(() => ws.simulateMessage({ type: 'user_left', userId: 'user2' }));
    expect(result.current.users).not.toContain('user2');
  });

  it('rolls back optimistic stroke on RAFT write failure', async () => {
    const { result } = renderHook(() => useBoard({ boardId: 'abc', userId: 'user1' }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    act(() => ws.simulateOpen());

    const stroke: Stroke = {
      id: 's-rollback', boardId: 'abc', userId: 'user1', color: '#E74C3C',
      width: 3, points: [[0, 0], [20, 20]], timestamp: 3000,
    };

    act(() => result.current.addStroke(stroke));
    expect(result.current.strokes.some((s) => s.id === 's-rollback')).toBe(true);

    act(() => ws.simulateMessage({
      type: 'error',
      message: 'Failed to submit stroke',
      code: 'RAFT_WRITE_FAILED',
      strokeId: 's-rollback',
      retryable: true,
    }));

    expect(result.current.strokes.some((s) => s.id === 's-rollback')).toBe(false);
  });

  it('supports undo and redo as compensation events', async () => {
    const { result } = renderHook(() => useBoard({ boardId: 'abc', userId: 'user1' }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    act(() => ws.simulateOpen());
    ws.send.mockClear();

    const stroke: Stroke = {
      id: 's-undo', boardId: 'abc', userId: 'user1', color: '#E74C3C',
      width: 3, points: [[0, 0], [20, 20]], timestamp: 3000,
    };

    act(() => result.current.addStroke(stroke));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.strokes.some((s) => s.id === 's-undo')).toBe(true);

    act(() => result.current.undoLastStroke());
    expect(result.current.strokes.some((s) => s.id === 's-undo')).toBe(false);
    expect(result.current.canRedo).toBe(true);

    const undoMessage = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string) as { type: string; stroke: Stroke };
    expect(undoMessage.type).toBe('stroke');
    expect(undoMessage.stroke.action).toBe('undo_stroke');
    expect(undoMessage.stroke.targetStrokeId).toBe('s-undo');

    act(() => result.current.redoLastStroke());
    expect(result.current.strokes.some((s) => s.id === 's-undo')).toBe(true);

    const redoMessage = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[2][0] as string) as { type: string; stroke: Stroke };
    expect(redoMessage.type).toBe('stroke');
    expect(redoMessage.stroke.action).toBe('redo_stroke');
    expect(redoMessage.stroke.targetStrokeId).toBe('s-undo');
  });
});
