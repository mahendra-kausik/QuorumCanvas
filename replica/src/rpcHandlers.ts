import { Router } from 'express';
import type { RaftNode } from './raftNode.js';

export function createRpcRouter(raftNode: RaftNode): Router {
  const router = Router();

  router.post('/request-vote', (req, res) => {
    const result = raftNode.handleRequestVote(req.body);
    res.json(result);
  });

  router.post('/append-entries', (req, res) => {
    const result = raftNode.handleAppendEntries(req.body);
    res.json(result);
  });

  router.post('/heartbeat', (req, res) => {
    const result = raftNode.handleHeartbeat(req.body);
    res.json(result);
  });

  router.post('/sync-log', (req, res) => {
    const result = raftNode.handleSyncLog(req.body);
    res.json(result);
  });

  router.post('/install-snapshot', (req, res) => {
    const result = raftNode.handleInstallSnapshot(req.body);
    res.json(result);
  });

  router.post('/client-write', async (req, res) => {
    const result = await raftNode.handleClientWrite(req.body.stroke);
    res.json(result);
  });

  router.get('/status', (_req, res) => {
    res.json(raftNode.getStatus());
  });

  router.get('/board-state', async (req, res) => {
    const boardId = req.query.boardId as string;
    if (!boardId) {
      res.status(400).json({ error: 'boardId query parameter required' });
      return;
    }
    // ReadIndex-confirmed (L3): only a leader that just proved (via majority heartbeat) it
    // hasn't been superseded may answer. 421 (Misdirected Request) signals "not authoritative,
    // try leaderHint" — distinct from a confirmed-empty board (200, strokes: []).
    const result = await raftNode.readBoardState(boardId);
    if (!result.success) {
      res.status(421).json({ leaderHint: result.leaderHint });
      return;
    }
    res.json({ boardId, strokes: result.strokes });
  });

  return router;
}
