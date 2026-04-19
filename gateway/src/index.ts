import { createServer } from 'http';
import { createWsServer } from './wsServer.js';
import { collectClusterStatus } from './clusterStatus.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const raftPeers = (process.env.RAFT_PEERS ?? '')
  .split(',')
  .map((peer) => peer.trim())
  .filter((peer) => peer.length > 0);

function writeCors(res: import('http').ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: import('http').ServerResponse, statusCode: number, body: unknown): void {
  writeCors(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? '/';

    if (req.method === 'OPTIONS') {
      writeCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'gateway' });
      return;
    }

    if (url === '/cluster-status') {
      if (raftPeers.length === 0) {
        sendJson(res, 503, {
          error: 'RAFT_PEERS not configured',
        });
        return;
      }

      const status = await collectClusterStatus(raftPeers);
      sendJson(res, 200, status);
      return;
    }

    writeCors(res);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Mini-RAFT Gateway\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
});

const { wss } = createWsServer(server);

server.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
