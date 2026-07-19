import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createWsServer } from './wsServer.js';
import { collectClusterStatus } from './clusterStatus.js';
import { parseGatewayConfig, type GatewayConfig } from './config.js';
import { tokensMatch } from './security.js';

// Factored out (mirrors replica's createApp) so tests can spin up a real server on an
// ephemeral port without depending on module-load side effects or the process env.
export function createGatewayServer(config: GatewayConfig) {
  const { raftPeers, authToken, allowedOrigins } = config;

  // L6: echo the request Origin only if it's allowlisted (or the list explicitly opts out with
  // '*') — replaces the previous blanket Access-Control-Allow-Origin: *.
  function writeCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  function isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    return tokensMatch(token, authToken);
  }

  function sendJson(req: IncomingMessage, res: ServerResponse, statusCode: number, body: unknown): void {
    writeCors(req, res);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';

      if (req.method === 'OPTIONS') {
        writeCors(req, res);
        res.writeHead(204);
        res.end();
        return;
      }

      // Liveness probe must not require a secret.
      if (url === '/health') {
        sendJson(req, res, 200, { status: 'ok', service: 'gateway' });
        return;
      }

      if (url === '/cluster-status') {
        if (!isAuthorized(req)) {
          sendJson(req, res, 401, { error: 'Unauthorized' });
          return;
        }

        if (raftPeers.length === 0) {
          sendJson(req, res, 503, {
            error: 'RAFT_PEERS not configured',
          });
          return;
        }

        const status = await collectClusterStatus(raftPeers);
        sendJson(req, res, 200, status);
        return;
      }

      writeCors(req, res);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Mini-RAFT Gateway\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(req, res, 500, { error: message });
    }
  });

  const { wss } = createWsServer(server);

  return { server, wss };
}

// Only start listening when run directly (not imported by tests) — mirrors replica/src/index.ts.
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  const config = parseGatewayConfig(process.env);
  const { server, wss } = createGatewayServer(config);

  server.listen(config.port, () => {
    console.log(`Gateway listening on port ${config.port}`);
    console.log(`WebSocket endpoint: ws://localhost:${config.port}/ws`);
  });

  process.on('SIGINT', () => {
    console.log('Shutting down...');
    wss.close();
    server.close();
    process.exit(0);
  });
}
