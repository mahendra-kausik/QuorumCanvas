# Mini-RAFT

Mini-RAFT is a distributed, fault-tolerant collaborative drawing board.

It combines:
- A React frontend canvas (multi-user drawing, undo/redo)
- A WebSocket gateway (client coordination, board sessions)
- A RAFT replica cluster (leader election, replicated log, majority commit)

The project is designed for demos of leader failover, replica catch-up, and network partition recovery.

## Core Features

- Real-time collaborative drawing over WebSocket
- RAFT-backed write path (majority commit required)
- Leader failover with continued writes after re-election
- Follower catch-up after restart
- Undo/redo implemented as compensation entries in the replicated log
- Dashboard for live replica health and RAFT status
- Docker hot-reload dev stack with 4 replicas
- Demo scripts that capture logs and snapshots automatically

## Repository Layout

```text
Mini-Raft/
├── README.md
├── Documentation.md
├── CHANGELOG.md
├── docker-compose.yml
├── frontend/          # React + Vite client
├── gateway/           # Node WebSocket + HTTP gateway
├── replica/           # RAFT node implementation
├── replica1/          # Bind-mount folder (compose)
├── replica2/          # Bind-mount folder (compose)
├── replica3/          # Bind-mount folder (compose)
├── replica4/          # Bind-mount folder (compose)
├── scripts/           # Failover and partition demo scripts
├── tests/             # Service-level test suites
└── logs/              # Script-generated artifacts
```

## Architecture At A Glance

Write flow:
1. Frontend sends `stroke` over WebSocket to gateway.
2. Gateway forwards write to RAFT leader (`/client-write`) via `RemoteRaftClient`.
3. Leader appends entry, replicates to followers, commits on majority.
4. Gateway broadcasts committed stroke to connected board clients.

Read/join flow:
1. Client sends `join` for a board.
2. Gateway fetches board state from replicas (`/board-state`).
3. Gateway sends `join_ack` with current strokes.

## Services And Ports

- Frontend: `http://localhost:5173`
- Gateway HTTP + WS: `http://localhost:8080`, `ws://localhost:8080/ws`
- Replica1: `http://localhost:3001`
- Replica2: `http://localhost:3002`
- Replica3: `http://localhost:3003`
- Replica4: `http://localhost:3004`

## Prerequisites

- Node.js 20+
- npm
- Docker + Docker Compose (for full cluster demo)
- Bash (Git Bash on Windows is fine for scripts)

## Quick Start (Recommended: Docker)

```bash
docker compose up --build -d
docker compose ps
```

Open:
- Frontend: `http://localhost:5173`
- Dashboard: `http://localhost:5173/dashboard`
- Gateway health: `http://localhost:8080/health`
- Cluster status: `http://localhost:8080/cluster-status`

Stop everything:

```bash
docker compose down
```

## Local Development (Without Docker)

Run each service in separate terminals.

### 1) Replica nodes

From `replica/`:

```bash
npm install
```

Run 4 nodes:

```bash
# replica1
REPLICA_ID=replica1 PORT=3001 PEERS="http://localhost:3002,http://localhost:3003,http://localhost:3004" npm run dev

# replica2
REPLICA_ID=replica2 PORT=3002 PEERS="http://localhost:3001,http://localhost:3003,http://localhost:3004" npm run dev

# replica3
REPLICA_ID=replica3 PORT=3003 PEERS="http://localhost:3001,http://localhost:3002,http://localhost:3004" npm run dev

# replica4
REPLICA_ID=replica4 PORT=3004 PEERS="http://localhost:3001,http://localhost:3002,http://localhost:3003" npm run dev
```

### 2) Gateway

From `gateway/`:

```bash
npm install
RAFT_PEERS="http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost:3004" npm run dev
```

### 3) Frontend

From `frontend/`:

```bash
npm install
npm run dev
```

Optional env vars for frontend:
- `VITE_WS_URL` (default: `ws://localhost:8080/ws`)
- `VITE_GATEWAY_HTTP_URL` (default: `http://localhost:8080`)

## HTTP APIs

### Gateway

- `GET /health`
- `GET /cluster-status` (requires `RAFT_PEERS`)
- `WS /ws?boardId=<id>&userId=<id>`

### Replica

- `POST /request-vote`
- `POST /append-entries`
- `POST /heartbeat`
- `POST /sync-log`
- `POST /client-write`
- `GET /health`
- `GET /status`
- `GET /board-state?boardId=<id>`

## WebSocket Message Model

Client to gateway:
- `join` (`boardId`, `userId`)
- `stroke` (`stroke` payload)

Gateway to client:
- `join_ack`
- `stroke_broadcast`
- `user_joined`
- `user_left`
- `error`

Notes:
- Same user can have multiple tabs on one board.
- Broadcast exclusion is socket-based, so same-user tabs still receive each other's updates.

## RAFT Behavior Implemented

- States: follower, candidate, leader
- Randomized election timeout with replica-specific skew
- Heartbeat interval and append-based replication
- Majority commit rule
- Leader demotion when higher term is observed
- Catch-up sync for lagging/restarted followers
- Committed-entry conflict protection

## Demo Scripts

From repository root:

```bash
bash scripts/test-failover.sh
bash scripts/test-network-partition.sh
```

Outputs are saved under timestamped folders in `logs/` and include:
- Replica status snapshots
- Write responses
- Docker compose logs

## Testing

Run per service:

```bash
cd frontend && npm test
cd ../gateway && npm test
cd ../replica && npm test
```

CI is configured in `.github/workflows/ci.yml` to build and test all three services on push/PR to `main`.

## Useful Commands

```bash
# Rebuild and restart all services
docker compose up --build -d

# Follow gateway logs
docker compose logs -f gateway

# Follow all replica logs
docker compose logs -f replica1 replica2 replica3 replica4

# Restart only gateway
docker compose restart gateway
```

## Current Limitations

- State is in-memory (no durable disk persistence across full cluster teardown)
- No authentication or authorization on WS/API paths
- No TLS between internal replica RPC peers
- Intended for local/lab environments and demo workflows

## Additional Documentation

- Deep architecture and protocol notes: `Documentation.md`
- Chronological change history: `CHANGELOG.md`
