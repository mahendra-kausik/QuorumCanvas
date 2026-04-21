# Mini-RAFT Project Report

Mahendra Kausik V - PES1UG23AM163

MS Ananthesha - PES1UG23AM161

Purandar Puneet - PES1UG23AM906

## 1. Abstract
Mini-RAFT is a distributed, fault-tolerant collaborative drawing board built to demonstrate consensus-driven state management in a real-time application. The system combines a React frontend, a Node.js WebSocket gateway, and a 4-node RAFT replica cluster. The main goal is to guarantee that drawing updates become visible to users only after majority commit, while still providing responsive user experience through optimistic rendering and rollback.

## 2. Problem Statement
Real-time collaborative applications require a shared state that remains correct even when nodes fail, restart, or become partitioned. Simple broadcast systems can show inconsistent views across users. This project addresses that issue by routing all write operations through RAFT so that updates are replicated and committed safely before they are treated as authoritative state.

## 3. Objectives
- Build a real-time multi-user drawing board.
- Implement leader election, heartbeat management, and log replication using RAFT principles.
- Enforce majority-based commit semantics for writes.
- Support follower catch-up after restart or lag.
- Demonstrate failover and network partition behavior with reproducible scripts.
- Provide observability through a cluster status dashboard.

## 4. System Architecture
The system consists of three runtime services and one observability view:

### 4.1 Frontend (React + Vite)
- Renders collaborative canvas and user tools.
- Sends and receives events through WebSocket.
- Uses optimistic local rendering for low-latency user feedback.
- Tracks pending entries and rolls back when write commit fails.

### 4.2 Gateway (Node.js)
- Exposes WebSocket endpoint for clients and HTTP APIs for status.
- Handles board session coordination and user presence.
- Forwards client writes to RAFT leader via `POST /client-write`.
- Retries leader routing based on leader hints and bounded backoff.
- Aggregates replica health/status into `GET /cluster-status`.

### 4.3 Replica Cluster (4 RAFT nodes)
- Maintains RAFT state roles: follower, candidate, leader.
- Executes election, heartbeat, replication, and catch-up logic.
- Replicates log entries across peers and commits on majority.
- Protects committed entries from overwrite during conflict resolution.

### 4.4 Dashboard
- Polls gateway cluster endpoint.
- Displays leader, term, commit index, log length, and replica health.

## 5. Communication Model

### 5.1 Client <-> Gateway (WebSocket)
Client messages:
- `join`
- `stroke`

Gateway messages:
- `join_ack`
- `stroke_broadcast`
- `user_joined`
- `user_left`
- `error`

### 5.2 Gateway <-> Replicas (HTTP RPC)
- `POST /client-write`
- `POST /append-entries`
- `POST /request-vote`
- `POST /heartbeat`
- `POST /sync-log`
- `GET /status`
- `GET /health`
- `GET /board-state`

## 6. Data Model and State Semantics
Each drawing action is represented as an immutable log entry (example fields: `strokeId`, `userId`, `path`, `color`, `timestamp`, `action`). Undo/redo are represented as compensation entries (`undo_stroke`, `redo_stroke`) rather than in-place mutation. This keeps log history append-only and consistent with RAFT safety assumptions.

## 7. RAFT Protocol Behavior Implemented

### 7.1 Leader Election
- Followers wait for heartbeat.
- On timeout, a follower becomes candidate and requests votes.
- Candidate becomes leader after majority votes.
- Any node demotes to follower when higher term is observed.

### 7.2 Replication and Commit
- Leader appends client entry locally.
- Leader sends AppendEntries to followers.
- Commit index advances when majority replicate current-term entry.
- Only committed state is broadcast and exposed to clients.

### 7.3 Catch-Up and Recovery
- Followers reject mismatched AppendEntries and report current length.
- Leader adjusts `nextIndex`/`matchIndex` and retries replication.
- `sync-log` provides committed suffix for lagging or restarted followers.
- Follower applies committed entries and updates `commitIndex` and `lastApplied`.

## 8. End-to-End Workflow
1. User joins board through WebSocket `join`.
2. Gateway returns `join_ack` with current committed board state.
3. User draws stroke; frontend shows optimistic local stroke (pending).
4. Gateway forwards write to leader using `POST /client-write`.
5. Leader appends and replicates to followers via AppendEntries.
6. On majority replication, leader commits and returns success.
7. Gateway broadcasts `stroke_broadcast` to all board clients.
8. Clients mark pending stroke as confirmed.
9. If commit fails, optimistic stroke is rolled back.

## 9. Fault Tolerance Demonstrated
- Leader crash and re-election.
- Continued writes after failover.
- Follower restart and catch-up replay.
- Network partition with majority/minority behavior.
- Temporary no-leader windows with retry/backoff at gateway and rollback at frontend.

## 10. Deployment and Operations

### 10.1 Dockerized Dev Stack
- Services: frontend, gateway, replica1, replica2, replica3, replica4.
- Health checks coordinate startup ordering.
- Bind mounts support hot reload during development.

### 10.2 Service Endpoints
- Frontend: `http://localhost:5173`
- Gateway: `http://localhost:8080`, WS `ws://localhost:8080/ws`
- Replicas: `http://localhost:3001` to `http://localhost:3004`

## 11. Testing and Validation
- Test suites exist for frontend, gateway, and replica modules.
- Failover and partition scripts produce reproducible artifacts under `logs/`.
- Status snapshots and service logs are captured to support verification and demo evidence.

## 12. Key Results
- Real-time collaborative drawing with RAFT-backed write path.
- Majority-commit semantics verified through failover testing.
- Replica catch-up works for restarted/lagging nodes.
- Dashboard improves transparency of cluster behavior in demos.

## 13. Limitations
- In-memory state (no durable storage across full teardown).
- No authentication/authorization on API and WebSocket paths.
- No TLS for internal peer communication.
- Designed for local/lab demo environment, not production deployment.

## 14. Future Work
- Add durable storage and snapshotting.
- Add authentication and role-based access control.
- Add TLS for inter-service and client communication.
- Improve dynamic membership and scaling strategy.
- Add richer metrics and tracing for deeper observability.

## 15. Conclusion
Mini-RAFT demonstrates how consensus can be integrated into an interactive application without sacrificing usability. The project successfully combines optimistic frontend UX with strict majority-based commit semantics, providing a practical and observable platform for understanding leader election, replication, failover, and recovery in distributed systems.

## 16. Reference Files
- `README.md`
- `Documentation.md`
- `docker-compose.yml`
- `scripts/test-failover.sh`
- `scripts/test-network-partition.sh`
- `tests/`
