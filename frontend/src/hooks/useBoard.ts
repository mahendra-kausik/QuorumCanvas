import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Stroke, ServerMessage } from '../types';
import { useWebSocket } from './useWebSocket';
import { logStroke } from '../utils/logger';
import { generateId } from '../utils/strokeUtils';

interface UseBoardOptions {
  boardId: string;
  userId: string;
}

export function useBoard({ boardId, userId }: UseBoardOptions) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [redoStrokeIds, setRedoStrokeIds] = useState<string[]>([]);
  const strokeArchiveRef = useRef<Map<string, Stroke>>(new Map());
  const pendingRollbackRef = useRef<Map<string, () => void>>(new Map());
  const pendingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const applyStrokeEvent = useCallback((current: Stroke[], event: Stroke): Stroke[] => {
    const action = event.action ?? 'stroke';

    if (action === 'undo_stroke' && event.targetStrokeId) {
      return current.filter((stroke) => stroke.id !== event.targetStrokeId);
    }

    if (action === 'redo_stroke' && event.targetStrokeId) {
      if (current.some((stroke) => stroke.id === event.targetStrokeId)) {
        return current;
      }
      const target = strokeArchiveRef.current.get(event.targetStrokeId);
      if (!target) {
        return current;
      }
      return [...current, target];
    }

    if (current.some((stroke) => stroke.id === event.id)) {
      return current;
    }

    strokeArchiveRef.current.set(event.id, event);
    return [...current, event];
  }, []);

  const trackPending = useCallback((strokeId: string, rollback: () => void) => {
    pendingRollbackRef.current.set(strokeId, rollback);

    const existingTimer = pendingTimersRef.current.get(strokeId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      pendingRollbackRef.current.delete(strokeId);
      pendingTimersRef.current.delete(strokeId);
    }, 20000);

    pendingTimersRef.current.set(strokeId, timer);
  }, []);

  const clearPending = useCallback((strokeId: string) => {
    const timer = pendingTimersRef.current.get(strokeId);
    if (timer) {
      clearTimeout(timer);
      pendingTimersRef.current.delete(strokeId);
    }
    pendingRollbackRef.current.delete(strokeId);
  }, []);

  const runPendingRollback = useCallback((strokeId: string) => {
    const rollback = pendingRollbackRef.current.get(strokeId);
    clearPending(strokeId);
    if (rollback) {
      rollback();
      return;
    }

    setStrokes((prev) => prev.filter((stroke) => stroke.id !== strokeId));
  }, [clearPending]);

  useEffect(() => {
    return () => {
      for (const timer of pendingTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pendingTimersRef.current.clear();
      pendingRollbackRef.current.clear();
    };
  }, []);

  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'join_ack':
        strokeArchiveRef.current = new Map(
          message.strokes
            .filter((stroke) => (stroke.action ?? 'stroke') === 'stroke')
            .map((stroke) => [stroke.id, stroke]),
        );
        setStrokes(message.strokes);
        setRedoStrokeIds([]);
        break;
      case 'stroke_broadcast':
        setStrokes((prev) => applyStrokeEvent(prev, message.stroke));
        break;
      case 'user_joined':
        setUsers((prev) => (prev.includes(message.userId) ? prev : [...prev, message.userId]));
        break;
      case 'user_left':
        setUsers((prev) => prev.filter((id) => id !== message.userId));
        break;
      case 'error':
        if (message.code === 'RAFT_WRITE_FAILED' && message.strokeId) {
          runPendingRollback(message.strokeId);
        }
        console.error(`[Board] Error: ${message.message}`);
        break;
    }
  }, [applyStrokeEvent, runPendingRollback]);

  const { status, send } = useWebSocket({ boardId, userId, onMessage: handleMessage });

  const submitStrokeMessage = useCallback((stroke: Stroke, rollback: () => void): boolean => {
    trackPending(stroke.id, rollback);
    const sent = send({ type: 'stroke', stroke });
    if (!sent) {
      runPendingRollback(stroke.id);
    }
    return sent;
  }, [runPendingRollback, send, trackPending]);

  const ownVisibleStrokeIds = useMemo(
    () =>
      strokes
        .filter((stroke) => stroke.userId === userId && (stroke.action ?? 'stroke') === 'stroke')
        .map((stroke) => stroke.id),
    [strokes, userId],
  );

  const canUndo = ownVisibleStrokeIds.length > 0;
  const canRedo = redoStrokeIds.length > 0;

  const addStroke = useCallback(
    (stroke: Stroke) => {
      logStroke(stroke);
      strokeArchiveRef.current.set(stroke.id, stroke);
      setStrokes((prev) => applyStrokeEvent(prev, stroke));
      setRedoStrokeIds([]);

      submitStrokeMessage(stroke, () => {
        setStrokes((prev) => prev.filter((existing) => existing.id !== stroke.id));
      });
    },
    [applyStrokeEvent, submitStrokeMessage],
  );

  const undoLastStroke = useCallback(() => {
    const targetStrokeId = ownVisibleStrokeIds[ownVisibleStrokeIds.length - 1];
    if (!targetStrokeId) return;

    const targetStroke = strokeArchiveRef.current.get(targetStrokeId);
    if (!targetStroke) return;

    const undoEvent: Stroke = {
      id: generateId(),
      boardId,
      userId,
      color: '#000000',
      width: 0,
      points: [],
      timestamp: Date.now(),
      action: 'undo_stroke',
      targetStrokeId,
    };

    setStrokes((prev) => applyStrokeEvent(prev, undoEvent));
    setRedoStrokeIds((prev) => [...prev, targetStrokeId]);

    submitStrokeMessage(undoEvent, () => {
      setStrokes((prev) => (prev.some((stroke) => stroke.id === targetStrokeId) ? prev : [...prev, targetStroke]));
      setRedoStrokeIds((prev) => prev.filter((id) => id !== targetStrokeId));
    });
  }, [applyStrokeEvent, boardId, ownVisibleStrokeIds, submitStrokeMessage, userId]);

  const redoLastStroke = useCallback(() => {
    const targetStrokeId = redoStrokeIds[redoStrokeIds.length - 1];
    if (!targetStrokeId) return;

    const targetStroke = strokeArchiveRef.current.get(targetStrokeId);
    if (!targetStroke) return;

    const redoEvent: Stroke = {
      id: generateId(),
      boardId,
      userId,
      color: '#000000',
      width: 0,
      points: [],
      timestamp: Date.now(),
      action: 'redo_stroke',
      targetStrokeId,
    };

    setStrokes((prev) => applyStrokeEvent(prev, redoEvent));
    setRedoStrokeIds((prev) => prev.slice(0, -1));

    submitStrokeMessage(redoEvent, () => {
      setStrokes((prev) => prev.filter((stroke) => stroke.id !== targetStrokeId));
      setRedoStrokeIds((prev) => [...prev, targetStrokeId]);
    });
  }, [applyStrokeEvent, boardId, redoStrokeIds, submitStrokeMessage, userId]);

  return {
    strokes,
    users,
    status,
    addStroke,
    undoLastStroke,
    redoLastStroke,
    canUndo,
    canRedo,
  };
}
