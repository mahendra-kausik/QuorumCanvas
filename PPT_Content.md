# Mini-RAFT PPT Content

Use this as a direct slide-by-slide script for your presentation.

## Slide 1 - Title

Title:
- Mini-RAFT: Fault-Tolerant Real-Time Collaborative Drawing

Subtitle:
- Distributed systems assignment implementation with leader election, failover, and recovery demos

Presenter notes:
- This project demonstrates how a user-facing real-time app can remain consistent under failures by placing writes behind a RAFT consensus layer.

## Slide 2 - Problem Statement

Slide bullets:
- Real-time collaboration needs low latency and consistent shared state.
- Single-server designs are simple but become a single point of failure.
- We need a system that keeps working when a node crashes.

Presenter notes:
- The key challenge is balancing UX speed with consistency and fault tolerance.

## Slide 3 - Solution Overview

Slide bullets:
- Frontend (React): collaborative canvas and dashboard.
- Gateway (Node + WebSocket): client coordination and routing.
- Replica cluster (Node + RAFT): consensus, commit, and recovery.
- Docker Compose: reproducible 4-replica demo environment.

Presenter notes:
- The gateway is the bridge between browser events and consensus-based persistence.

## Slide 4 - High-Level Architecture

Slide bullets:
- Browser tabs connect to gateway over WebSocket.
- Gateway forwards writes to RAFT leader using HTTP RPC.
- Leader replicates to followers and commits on majority.
- Gateway broadcasts committed events back to clients.

Optional diagram text:
- Clients -> Gateway (/ws)
- Gateway -> Replica leader (/client-write)
- Leader <-> Followers (/append-entries, /heartbeat, /request-vote, /sync-log)

Presenter notes:
- Emphasize that only committed data is treated as authoritative shared state.

## Slide 5 - RAFT Mechanics Implemented

Slide bullets:
- Node states: follower, candidate, leader.
- Election timeout with randomness and replica-specific skew.
- Heartbeats and append entries for replication.
- Majority commit rule: writes require quorum.
- Stale leader demotion on higher term.

Presenter notes:
- In a 4-node cluster, quorum is 3. This is key for both safety and failure behavior.

## Slide 6 - Data Model And Event Semantics

Slide bullets:
- Each draw action is a `stroke` event.
- Undo/redo are compensation events:
  - `undo_stroke` with `targetStrokeId`
  - `redo_stroke` with `targetStrokeId`
- Board state is derived from committed event history.

Presenter notes:
- We do not mutate old committed entries; we append corrective events, which is audit-friendly and replication-friendly.

## Slide 7 - Gateway Behavior

Slide bullets:
- WebSocket protocol: `join`, `stroke`, `join_ack`, `stroke_broadcast`, `user_joined`, `user_left`, `error`.
- Supports multi-tab same-user sessions.
- Excludes broadcast by sender socket, not sender userId.
- RemoteRaftClient retries writes with bounded exponential backoff.

Presenter notes:
- Mention the practical bug fix: same-user tabs now sync immediately because sockets are tracked separately.

## Slide 8 - Frontend UX And Reliability

Slide bullets:
- Optimistic local rendering for low-latency drawing.
- Deterministic rollback on RAFT write failure (`RAFT_WRITE_FAILED`).
- Auto-reconnect with exponential backoff.
- Live dashboard at `/dashboard` for replica health and leader view.

Presenter notes:
- This gives responsive UX while preserving consensus correctness.

## Slide 9 - Fault-Tolerance Demos

Slide bullets:
- Failover demo script:
  - Elect leader
  - Write stroke
  - Stop leader
  - Elect new leader
  - Write again
  - Restart old leader and verify catch-up
- Network partition demo script:
  - Isolate replica
  - Attempt write during partition
  - Heal network
  - Verify replica catch-up

Presenter notes:
- Both scripts generate artifacts in logs for traceability.

## Slide 10 - Testing Strategy

Slide bullets:
- Replica tests: election, replication, failover, catch-up, majority behavior.
- Gateway tests: WS flow, message handling, write routing/retries.
- Frontend tests: hooks/components, optimistic rollback, undo/redo behavior.
- CI pipeline runs build + tests for all services.

Presenter notes:
- Stress that reliability claims are backed by both unit and integration tests.

## Slide 11 - What Works Well / Tradeoffs

Slide bullets:
- Strengths:
  - Clear separation of concerns across tiers
  - Good fault demos and observability
  - Recovery and catch-up behavior implemented
- Tradeoffs:
  - In-memory state (no durable persistence)
  - No auth/TLS for production hardening
  - Intended for local/lab use

Presenter notes:
- Be explicit that this is a strong systems demo, not a production-hardened SaaS deployment.

## Slide 12 - Closing And Future Work

Slide bullets:
- Future extensions:
  - Persistent log storage and snapshots
  - AuthN/AuthZ and secure transport
  - Smarter client-side buffering during no-leader windows
  - Cloud deployment automation and metrics dashboards
- Final takeaway:
  - Consensus can be integrated into real-time UX without losing responsiveness.

Presenter notes:
- End by connecting distributed systems theory to practical product behavior.

## Bonus: 2-Minute Demo Script (Live)

Use these talking points during a live run:

1. Start stack: `docker compose up --build -d`
2. Open `http://localhost:5173` and join board in two tabs.
3. Draw stroke and show immediate sync.
4. Open dashboard `http://localhost:5173/dashboard` and identify leader.
5. Run `bash scripts/test-failover.sh` and narrate leader replacement.
6. Run `bash scripts/test-network-partition.sh` and narrate recovery.
7. Show `logs/` artifacts generated by scripts.
