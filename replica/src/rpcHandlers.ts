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

  router.get('/board-state', (req, res) => {
    const boardId = req.query.boardId as string;
    if (!boardId) {
      res.status(400).json({ error: 'boardId query parameter required' });
      return;
    }
    res.json({ boardId, strokes: raftNode.getStrokes(boardId) });
  });

  return router;
}
