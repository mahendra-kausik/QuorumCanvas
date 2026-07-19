import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { BoardManager } from './boardManager.js';
import { MessageHandler } from './messageHandler.js';
import { LocalRaftClient } from './raftClient.js';
import { RemoteRaftClient } from './remoteRaftClient.js';
import { parseGatewayConfig, GATEWAY_SECURITY } from './config.js';
import { tokensMatch } from './security.js';

export interface ConnectionInfo {
  boardId: string;
  userId: string;
  // L6: fixed-window per-connection rate limit state (reset when the window rolls).
  strokeCount: number;
  windowStart: number;
}

export function createWsServer(server: Server) {
  const boardManager = new BoardManager();
  const { raftPeers, maxUsersPerBoard, authToken } = parseGatewayConfig(process.env);

  const raftClient = raftPeers.length > 0
    ? new RemoteRaftClient(raftPeers)
    : new LocalRaftClient(boardManager);

  if (raftPeers.length > 0) {
    console.log(`[gateway] Using RemoteRaftClient with peers: ${raftPeers.join(',')}`);
  } else {
    console.log('[gateway] Using LocalRaftClient (no RAFT_PEERS set)');
  }

  const messageHandler = new MessageHandler(boardManager, raftClient);
  const connections = new Map<WebSocket, ConnectionInfo>();

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: GATEWAY_SECURITY.maxWsPayloadBytes });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const boardId = url.searchParams.get('boardId');
    const userId = url.searchParams.get('userId');
    const token = url.searchParams.get('token');

    // L6: reject before any other check — an unauthenticated client learns nothing else.
    if (!tokensMatch(token, authToken)) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    if (!boardId || !userId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing boardId or userId query parameter' }));
      ws.close();
      return;
    }

    const userAlreadyConnected = boardManager.hasUser(boardId, userId);
    if (!userAlreadyConnected && boardManager.getUserCount(boardId) >= maxUsersPerBoard) {
      ws.send(JSON.stringify({ type: 'error', message: 'Board user limit reached' }));
      ws.close();
      return;
    }

    const connectionInfo: ConnectionInfo = { boardId, userId, strokeCount: 0, windowStart: Date.now() };
    connections.set(ws, connectionInfo);

    console.log(`[connect] board=${boardId} user=${userId}`);

    ws.on('message', (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString();
      messageHandler.handleMessage(ws, str, connectionInfo).catch((err) => {
        console.error(`[error] board=${boardId} user=${userId}`, err);
        boardManager.sendTo(ws, { type: 'error', message: 'Internal server error' });
      });
    });

    ws.on('close', () => {
      console.log(`[disconnect] board=${boardId} user=${userId}`);
      connections.delete(ws);
      const fullyDisconnected = boardManager.leaveBoard(boardId, userId, ws);
      if (fullyDisconnected) {
        boardManager.broadcast(boardId, { type: 'user_left', userId }, ws);
      }
    });
  });

  return { wss, boardManager, connections };
}
