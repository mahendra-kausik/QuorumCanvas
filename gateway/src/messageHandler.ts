import type WebSocket from 'ws';
import type { ClientMessage, Stroke } from './types.js';
import type { BoardManager } from './boardManager.js';
import type { RaftClient } from './raftClient.js';

export class MessageHandler {
  constructor(
    private boardManager: BoardManager,
    private raftClient: RaftClient,
  ) {}

  async handleMessage(ws: WebSocket, data: string, connectionInfo: { boardId: string; userId: string }): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(data) as ClientMessage;
    } catch {
      this.boardManager.sendTo(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (!message.type) {
      this.boardManager.sendTo(ws, { type: 'error', message: 'Missing message type' });
      return;
    }

    switch (message.type) {
      case 'join':
        this.handleJoin(ws, message.boardId, message.userId);
        break;
      case 'stroke':
        await this.handleStroke(ws, message.stroke, connectionInfo);
        break;
      default:
        this.boardManager.sendTo(ws, { type: 'error', message: `Unknown message type: ${(message as { type: string }).type}` });
    }
  }

  private async handleJoin(ws: WebSocket, boardId: string, userId: string): Promise<void> {
    this.boardManager.joinBoard(boardId, userId, ws);

    const strokes = await this.raftClient.getStrokes(boardId);

    this.boardManager.sendTo(ws, {
      type: 'join_ack',
      boardId,
      strokes,
    });

    this.boardManager.broadcast(boardId, {
      type: 'user_joined',
      userId,
    }, userId);
  }

  private async handleStroke(ws: WebSocket, stroke: Stroke, connectionInfo: { boardId: string; userId: string }): Promise<void> {
    if (!stroke || !stroke.id) {
      this.boardManager.sendTo(ws, { type: 'error', message: 'Invalid stroke data' });
      return;
    }

    const success = await this.raftClient.submitStroke(stroke);
    if (!success) {
      this.boardManager.sendTo(ws, {
        type: 'error',
        message: 'Failed to submit stroke',
        code: 'RAFT_WRITE_FAILED',
        strokeId: stroke.id,
        retryable: true,
      });
      return;
    }

    this.boardManager.broadcast(connectionInfo.boardId, {
      type: 'stroke_broadcast',
      stroke,
    }, connectionInfo.userId);
  }
}
