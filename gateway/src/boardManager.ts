import type WebSocket from 'ws';
import type { Stroke, ServerMessage } from './types.js';

export interface Board {
  boardId: string;
  strokes: Stroke[];
  events: Stroke[];
  undoneStrokeIds: Set<string>;
  users: Map<string, Set<WebSocket>>;
}

export class BoardManager {
  private boards = new Map<string, Board>();

  getOrCreateBoard(boardId: string): Board {
    let board = this.boards.get(boardId);
    if (!board) {
      board = {
        boardId,
        strokes: [],
        events: [],
        undoneStrokeIds: new Set<string>(),
        users: new Map(),
      };
      this.boards.set(boardId, board);
    }
    return board;
  }

  getBoard(boardId: string): Board | undefined {
    return this.boards.get(boardId);
  }

  joinBoard(boardId: string, userId: string, ws: WebSocket): Stroke[] {
    const board = this.getOrCreateBoard(boardId);
    let userSockets = board.users.get(userId);
    if (!userSockets) {
      userSockets = new Set<WebSocket>();
      board.users.set(userId, userSockets);
    }
    userSockets.add(ws);
    return board.strokes;
  }

  hasUser(boardId: string, userId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;
    return board.users.has(userId);
  }

  leaveBoard(boardId: string, userId: string, ws: WebSocket): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;

    const userSockets = board.users.get(userId);
    if (!userSockets) return false;

    userSockets.delete(ws);
    if (userSockets.size === 0) {
      board.users.delete(userId);
      return true;
    }

    return false;
  }

  addStroke(boardId: string, stroke: Stroke): void {
    const board = this.getOrCreateBoard(boardId);
    const action = stroke.action ?? 'stroke';

    board.events.push(stroke);

    if (action === 'undo_stroke' && stroke.targetStrokeId) {
      board.undoneStrokeIds.add(stroke.targetStrokeId);
      board.strokes = board.strokes.filter((entry) => entry.id !== stroke.targetStrokeId);
      return;
    }

    if (action === 'redo_stroke' && stroke.targetStrokeId) {
      board.undoneStrokeIds.delete(stroke.targetStrokeId);
      const alreadyVisible = board.strokes.some((entry) => entry.id === stroke.targetStrokeId);
      if (!alreadyVisible) {
        const target = board.events.find(
          (event) => (event.action ?? 'stroke') === 'stroke' && event.id === stroke.targetStrokeId,
        );
        if (target) {
          board.strokes.push(target);
        }
      }
      return;
    }

    if (!board.undoneStrokeIds.has(stroke.id)) {
      board.strokes.push(stroke);
    }
  }

  getStrokes(boardId: string): Stroke[] {
    return this.boards.get(boardId)?.strokes ?? [];
  }

  broadcast(boardId: string, message: ServerMessage, excludeWs?: WebSocket): void {
    const board = this.boards.get(boardId);
    if (!board) return;
    const data = JSON.stringify(message);
    for (const userSockets of board.users.values()) {
      for (const ws of userSockets) {
        if (ws !== excludeWs && ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      }
    }
  }

  sendTo(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  getBoardCount(): number {
    return this.boards.size;
  }

  getUserCount(boardId: string): number {
    return this.boards.get(boardId)?.users.size ?? 0;
  }
}
