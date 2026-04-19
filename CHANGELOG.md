# Changelog

All notable changes to the Mini-RAFT project will be documented in this file.

## [2026-04-20] - Assignment Reliability, Dashboard, And Bonus Extensions
### Added
- Docker compose hot-reload stack with bind mounts, healthchecks, startup health ordering, frontend service, debug ports, and `replica4`
- Wrapper bind-mount folders: `replica1/`, `replica2/`, `replica3/`, `replica4/`
- Gateway cluster status aggregation endpoint (`GET /cluster-status`) and health endpoint (`GET /health`)
- Frontend RAFT dashboard page (`/dashboard`) showing leader, term, replica state, commit index, log length, and health
- Network partition demo script: `scripts/test-network-partition.sh`
- Log artifact folder and guidance: `logs/README.md`
- New tests:
	- gateway cluster status aggregation
	- board-manager undo/redo compensation behavior
	- frontend rollback on RAFT write failure
	- frontend undo/redo compensation event flow
	- replica committed overwrite protection and committed-only sync behavior
	- 4-replica majority integration behavior
### Changed
- RAFT node catch-up and mismatch handling now proactively sync committed entries when followers report log mismatch/length
- `/sync-log` now returns committed entries only from requested index onward
- Gateway remote client now uses bounded retry rounds with exponential backoff during temporary no-leader windows
- Gateway message handler now emits structured retryable write errors with `code`, `strokeId`, and `retryable`
- Frontend board logic now tracks pending optimistic writes and performs deterministic rollback on commit failure
- Frontend toolbar now includes undo/redo controls backed by compensation entries
- Failover script now captures status snapshots and compose logs into timestamped `logs/` run folders
### Fixed
- Committed log entries can no longer be truncated or overwritten by conflicting AppendEntries
- Optimistic local strokes are no longer left permanently visible when distributed commit fails
- Gateway TypeScript leader-hint narrowing issue in retry path

## [2026-03-15] - Integration Tests and Docker Failover Script
### Added
- In-process integration tests (7 tests) covering: leader election, stroke replication, leader crash + re-election, writes after failover, follower catch-up via /sync-log, write rejection with leader hint, stale leader demotion
- Docker failover test script (`scripts/test-failover.sh`) for manual/demo verification
### Fixed
- `requestCatchUp` no longer returns early when leader responds with a higher term (follower now updates term AND applies entries)

## [2026-03-15] - RAFT Replica Cluster with Docker
### Added
- Mini-RAFT consensus protocol implementation (Node.js + TypeScript + Express)
- `RaftNode` state machine: leader election, log replication, heartbeats, commit advancement
- `RaftLog` append-only log with 1-based indexing, truncation, and range queries
- `DefaultTimerManager` with randomized election timeout (500-800ms) and heartbeat interval (150ms)
- `HttpRpcClient` for peer-to-peer HTTP RPCs with timeout handling
- Express route handlers for `/request-vote`, `/append-entries`, `/heartbeat`, `/sync-log`, `/client-write`
- Query endpoints: `GET /health`, `GET /status`, `GET /board-state`
- Board state derived from committed log entries (in-memory `Map<boardId, Stroke[]>`)
- Follower catch-up via `/sync-log` for restarted nodes
- Stale leader demotion on higher term discovery
- Client write flow: leader appends, replicates to majority, commits, then acknowledges
- `RemoteRaftClient` in gateway: forwards strokes to RAFT leader, follows leader hints on redirect
- Gateway auto-detects `RAFT_PEERS` env var to switch between local and remote RAFT client
- Dockerfiles for gateway and replica
- `docker-compose.yml` with 1 gateway + 3 replicas on shared bridge network
- Structured JSON logging for elections, terms, commits, retries, catch-up, leader transitions
- 68 replica tests across 5 suites + 34 gateway tests across 5 suites (102 total)
- `test-replica` job added to CI pipeline

## [2026-03-15] - WebSocket Gateway Server
### Added
- Node.js + TypeScript WebSocket gateway server on port 8080
- `BoardManager` class for in-memory board state, user registry, and broadcast
- `MessageHandler` for JSON message parsing and dispatch (join, stroke)
- `LocalRaftClient` implementing `RaftClient` interface for in-memory stroke storage
- WebSocket server with connection lifecycle (connect, join, stroke relay, disconnect)
- Lazy board creation on first join, strokes persist in memory for reconnecting users
- Broadcasting rules: join_ack to joiner, user_joined/left to others, stroke_broadcast to non-senders
- Shared `types.ts` mirroring frontend message protocol
- 29 tests across 4 suites (boardManager, messageHandler, raftClient, wsServer integration)
- `test-gateway` job added to CI pipeline

## [2026-03-15] - Frontend Drawing Board with WebSocket Client
### Added
- React + TypeScript frontend scaffolded with Vite
- Freehand drawing canvas (1920x1080 logical pixels, CSS-scaled)
- 5-color toolbar (red, blue, green, orange, purple) with active indicator
- Stroke-based logging: each mousedown→mouseup captured as array of points
- Console logging of strokes, connections, and disconnections
- WebSocket client hook with auto-reconnect (exponential backoff 1s→30s)
- Board create/join flow: home page generates 6-char code or accepts manual entry
- React Router with `/` (home) and `/board/:boardId` (drawing) routes
- `useBoard` hook wiring stroke state, WebSocket, and optimistic local rendering
- Board state replay from `join_ack` and real-time `stroke_broadcast` handling
- User identity via `sessionStorage` (persists across refresh, unique per tab)
- 38 tests across 8 suites (components, hooks, utilities)
- GitHub Actions CI pipeline (`.github/workflows/ci.yml`)
