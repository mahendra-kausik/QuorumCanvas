import type WebSocket from 'ws';
import type { ClientMessage, Stroke } from './types.js';
import type { BoardManager } from './boardManager.js';
import type { RaftClient } from './raftClient.js';
import type { ConnectionInfo } from './wsServer.js';
import { validateStroke } from './security.js';
import { GATEWAY_SECURITY } from './config.js';

export class MessageHandler {
  constructor(
    private boardManager: BoardManager,
    private raftClient: RaftClient,
  ) {}

  async handleMessage(ws: WebSocket, data: string, connectionInfo: ConnectionInfo): Promise<void> {
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
    const isExistingUser = this.boardManager.hasUser(boardId, userId);
    this.boardManager.joinBoard(boardId, userId, ws);

    const strokes = await this.raftClient.getStrokes(boardId);

    this.boardManager.sendTo(ws, {
      type: 'join_ack',
      boardId,
      strokes,
    });

    if (!isExistingUser) {
      this.boardManager.broadcast(boardId, {
        type: 'user_joined',
        userId,
      }, ws);
    }
  }

  private async handleStroke(ws: WebSocket, stroke: Stroke, connectionInfo: ConnectionInfo): Promise<void> {
    const validation = validateStroke(stroke, connectionInfo);
    if (!validation.ok) {
      this.boardManager.sendTo(ws, { type: 'error', message: validation.reason });
      return;
    }

    // L6: fixed-window per-connection rate limit — resets each window, rejects over the cap
    // before the write ever reaches Raft.
    const now = Date.now();
    if (now - connectionInfo.windowStart >= GATEWAY_SECURITY.rateLimitWindowMs) {
      connectionInfo.windowStart = now;
      connectionInfo.strokeCount = 0;
    }
    connectionInfo.strokeCount += 1;
    if (connectionInfo.strokeCount > GATEWAY_SECURITY.strokeRateLimitPerSec) {
      this.boardManager.sendTo(ws, {
        type: 'error',
        message: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
        strokeId: stroke.id,
        retryable: true,
      });
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
    }, ws);
  }
}
