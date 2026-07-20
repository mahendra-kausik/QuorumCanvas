# PROGRESS.md — Mini-RAFT

> Read this FIRST at the start of every session. Update at the end of every layer.

## Last done
- **2026-07-21 — Layer 9 (Interview-defense pack + README rewrite) COMPLETE.** Final layer.
  Docs only — no code changed.
  - **`DEFENSE.md`** (new, D26): one section per `PROJECT_PLAN.md` §8 question (why majority
    quorum, commit safety / current-term rule, split vote, log divergence, what breaks without
    persistence, reads / ReadIndex, why not an off-the-shelf lib), each ending in concrete
    `file:line` citations into the real code — line numbers re-grepped against the current tree,
    not from memory. Ends with a property→test map.
  - **`README.md`** rewritten into "the paper": mermaid architecture diagram, benchmark table
    (the committed L8 numbers — local ~40 w/s, GCP 79 w/s / p50 197ms / p99 304ms / 3.4s
    failover), Raft-properties-and-where-they-live summary linking DEFENSE.md, deploy section
    pointing at `DEPLOY.md` (no hardcoded ephemeral tunnel URL), and an honest
    "Tradeoffs & caveats" section **replacing the now-stale "Current Limitations"** (which still
    claimed in-memory / no auth — false since L1/L6).
  - **Gate evidence (docs-only gate):** every DEFENSE.md citation re-verified against the live
    tree at write time — `updateCommitIndex` `raftNode.ts:458`, current-term guard `:463`,
    `becomeCandidate` `:130`, split-vote finalize `:183-192`, `handleAppendEntries` consistency
    `:301-312` + truncate/committed-protection `:314-331`, `persistState` `:91` + vote-fsync seam
    `:257-259`, `confirmLeadership` `:807` / `readBoardState` `:842`, timeouts `config.ts:50-52`,
    `truncateFrom` `raftLog.ts:66`, log-append fsync `raftLog.ts:34-36`; cited tests
    (`crashRecovery`/`readIndex`/`snapshot`/`backpressure`.test.ts) all exist. README benchmark
    numbers match `benchmarks/results/*.md` exactly (no invented figures); all relative links
    resolve (`DEFENSE.md`, `DECISIONS.md`, `Documentation.md`, `PROJECT_PLAN.md`, `DEPLOY.md`,
    `benchmarks/`). Grep confirms no stale "in-memory"/"no authentication"/"Current Limitations"
    left in README (**RESULT: PASS** — every defense answer cites real code; README reproduces
    the deploy + benchmarks). D26 logged. **All 9 build layers now complete.**
- **2026-07-21 — Layer 8 (Proof & benchmarks) COMPLETE.** Gate passed — reproducible numbers
  committed for both the local cluster and the live GCP deployment (evidence below).
  - **Harness** (D23): new zero-dependency `benchmarks/bench.mjs` — built-in `fetch` +
    `node:perf_hooks` only, no new npm package, no build step, run as plain `node
    benchmarks/bench.mjs <load|failover>`. `load` fires a fixed-shape/fixed-count batch of
    writes at bounded concurrency directly at the current leader's `/client-write` (no auth on
    that endpoint — L6 auth is gateway-only — and it only replies `success:true` after majority
    commit, so timing it is exactly §7 #3's "client submit → majority commit" latency).
    `failover` times `docker compose stop <leader>` → new leader elects + commits a write, then
    restarts the stopped container. §7 #4 (partition behavior) is left to the existing
    `scripts/test-network-partition.sh` — a pass/fail behavioral property, not a percentile,
    already proven live in L7b. Every run appends params + machine spec + results to
    `benchmarks/results/*.md`.
  - **Two real bugs found only by running the harness against the live GCP VM** (D25, not
    caught locally or by static review): `execSync(..., {stdio:'inherit'})` for `docker compose
    stop/start` reported a spurious nonzero exit over the `gcloud ssh`-relayed pty despite the
    command succeeding (fixed: piped stdio + explicit error surfacing); `parseArgs` only
    supported `--flag=value`, so the space-separated `--compose-file docker-compose.prod.yml`
    silently became `compose-file="true"` (the missing-value default) and got handed to
    `docker compose -f` as a literal filename (fixed: parser now accepts both flag syntaxes).
  - **Also fixed along the way** (D24, real regression, not part of L8's own scope): local
    `docker compose up` was broken since L7a's multi-stage Dockerfile rewrite —
    `docker-compose.yml` (dev)'s `npm run dev`/`tsx watch` needs the Dockerfile's `build` stage
    (devDependencies + `src/`), but an unqualified multi-stage build resolves to the last stage
    (`runtime`, prod-only deps, no source). Neither L7a nor L7b's gates exercised the dev compose
    file after the rewrite. Fixed with `target: build` on all 4 dev services;
    `docker-compose.prod.yml` untouched (correctly wants the final stage).
  - **Gate evidence — local** (`docker compose up --build -d`, all 5 containers healthy,
    `writes=500 concurrency=16`): `load` run twice back-to-back — **41.26** then **40.37**
    writes/s, p50 **388.7ms** then **387.7ms**, p99 **547.7ms** then **503.5ms** — same ballpark,
    the reproducibility property this layer's gate requires. `failover` — leader (replica2)
    stopped, replica1 elected and committed a write, cluster restored to 3/3 healthy:
    **failoverMs 3359.6**. Machine: local Docker Desktop host.
  - **Gate evidence — live GCP** (`mini-raft` VM, `docker-compose.prod.yml`, all 5 containers
    healthy throughout, harness run via a temporary portable Node 20 binary — no `npm`/
    TypeScript toolchain installed on the VM, consistent with D20 — deleted after use):
    `load` (`writes=500 concurrency=16`) — **79.03** writes/s, p50 **196.8ms**, p99 **304.4ms**.
    `failover` — leader (replica2) stopped, replica1 elected and committed a write, cluster
    restored to 5/5 healthy: **failoverMs 3360.5**. Machine: GCP `e2-small` (2 vCPU Intel Xeon
    @2.2GHz, 1.9GB RAM), `linux 6.8.0-1063-gcp`, Node v20.18.1. Result files committed:
    `benchmarks/results/2026-07-20T21-09-33-561Z-load.md`,
    `2026-07-20T21-18-14-317Z-failover.md`.
  - **§7 resume numbers**: ~40-80 committed writes/s (local/live), p50 commit latency
    ~197-389ms, p99 ~304-548ms (single-client-process load at concurrency 16 — not a hardware
    ceiling claim), automatic leader failover in ~3.4s across a 3-node cluster (dominated by the
    election timeout window + this harness's own 500ms polling granularity, not raw RPC cost).
  - **RESULT: PASS** — reproducible numbers committed for both environments; a same-environment
    re-run lands in the same ballpark (shown directly for local; GCP not re-run a second time to
    avoid burning more VM uptime, but uses the identical code path already proven reproducible
    locally).
- **2026-07-20 — Layer 7b (live GCP bring-up) COMPLETE.** L7 gate passed against the real
  deployed cluster (evidence below). D20 covers the two execution decisions made along the way.
  - **Live topology**: GCP project `mini-raft-prod`, VM `mini-raft` (`e2-small`, asia-south1-a,
    Ubuntu 22.04, billed to the free trial). Images built locally (Docker Desktop) and pushed to
    Artifact Registry (`asia-south1-docker.pkg.dev/mini-raft-prod/mini-raft/{replica,gateway}`)
    — the VM only `docker compose pull`s, never builds, avoiding `npm ci`+`tsc` on the 2GB
    shape (D20). Public entry: Cloudflare **quick tunnel** (`cloudflared-quick`, no account/
    domain) — ephemeral `*.trycloudflare.com` hostname (D20). Frontend on Vercel
    (`https://mini-raft-six.vercel.app`, stable alias), env vars point at the current tunnel URL.
  - **Bug found + fixed during the live gate, not by static review**: `GET /cluster-status`
    reported *every* peer (including healthy ones) as `"This operation was aborted"` whenever
    one peer was actually down. Root cause: the base image's musl libc resolves a *stopped*
    peer's Docker DNS name slowly (~5s NXDOMAIN retry, confirmed via `wget` inside the
    container), starving Node's default 4-thread libuv pool and delaying the concurrent,
    independent DNS lookups `clusterStatus.ts` fires for the still-healthy peers past their own
    1500ms budget too. Fixed by setting `UV_THREADPOOL_SIZE=16` on the gateway service in
    `docker-compose.prod.yml`; re-tested live (stopped the actual leader again) — the dashboard
    then correctly reported the down peer as unhealthy while the two healthy peers reported
    accurately. Not a Raft-core bug: `replica2`/`replica3`'s own `/status` showed the internal
    election/commit continuing correctly throughout, even before the gateway fix — this was a
    gateway status-aggregation defect only.
  - **L7 gate evidence (live, against the deployed VM)**:
    - **Public write**: real WebSocket client (join → stroke, same protocol the frontend uses)
      through `wss://<tunnel>/ws` → `commitIndex` 0→1 on all 3 replicas.
    - **Remote failover, twice**: `docker compose stop` on the leader container (`replica1`,
      then later `replica2`) → a follower won election each time (term 2→3, then 3→4) and kept
      committing through the public tunnel with no client-side change — `commitIndex` 1→2→3.
      Second round also validated the `UV_THREADPOOL_SIZE` fix live.
    - **Reboot survival**: `gcloud compute instances reset` (hard power-cycle, not a graceful
      `sudo reboot` — the stronger test, since it proves durability came from L1's per-RPC
      fsync, not a shutdown flush). VM `uptime` confirmed `0 min`; all 5 containers restarted
      automatically (`restart: unless-stopped`); all 3 replicas reloaded `commitIndex=3` (not
      reset to 0) and re-elected (term 4→5). The quick tunnel got a **new** ephemeral hostname
      on restart as expected/documented (D20's known ceiling of the token-free path) — re-fetched
      it from `cloudflared-quick` logs, updated the VM's `.env`/Vercel env vars, redeployed.
      Final end-to-end write through the new URL → `commitIndex=4`, `join_ack` showed all 4
      prior strokes preserved (**RESULT: PASS**).
  - **Also fixed along the way**: `docker compose` interpolates every service's env regardless
    of `--profile`, so the compose-level `TUNNEL_TOKEN:?required` guard on the named-tunnel
    service also blocked the token-free `quicktunnel` profile — relaxed to `TUNNEL_TOKEN:-`
    (the named-tunnel service still fails clearly at container startup if actually used without
    one).
  - **Live URLs at time of writing** (ephemeral tunnel — will change on any `cloudflared-quick`
    restart): frontend `https://mini-raft-six.vercel.app`, gateway
    `https://pens-coastal-poem-envelope.trycloudflare.com`.
- **2026-07-20 — D19: L7b cloud target switched from Oracle Always Free to GCP `e2-small`
  (asia-south1) on the $300/90-day free trial.** Oracle login/signup was blocked with no ETA;
  re-examined the actual requirement (season-length public demo for placement interviews, not
  lifetime hosting) and the user already had GCP trial credits enabled. `DEPLOY.md` §1
  (provisioning) and the free-tier notes rewritten for GCP; §2-6 (Cloudflare Tunnel, compose
  up, Vercel, L7 gate) unchanged — see D19 for full rationale/alternatives. **L7b (live bring-up)
  is still the open manual next step**, now against GCP instead of Oracle.
- **2026-07-19 — Layer 7a (Deployment artifacts) COMPLETE.** Gate passed for everything
  runnable without a real cloud account (evidence below).
  - **Split rationale** (D18): Oracle signup needs the user's card and console provisioning
    (VM, block volume, security list) can't be done by me — split into L7a (author + locally
    verify every deploy artifact, this entry) and L7b (user runs `DEPLOY.md` against the real
    VM/Cloudflare/Vercel, with me troubleshooting).
  - **Production images** (D18): `replica/Dockerfile`, `gateway/Dockerfile` now multi-stage —
    build stage (`npm ci` + `tsc`) → slim runtime stage (`npm ci --omit=dev`, copies only
    `dist/`, `USER node`). Runtime stage pre-creates `/app/instance` owned by `node` so a
    named-volume mount doesn't land root-owned under the non-root user (bug caught during
    local verify, see below).
  - **`docker-compose.prod.yml`** (new, dev compose untouched): no source bind mounts/`npm run
    dev`/debug ports; **named volumes** (`replica<N>-data`) for `DATA_DIR` so state survives a
    VM reboot; `AUTH_TOKEN`/`ALLOWED_ORIGINS`/`TUNNEL_TOKEN` required from a gitignored `.env`
    (`.env.example` committed as the template, `.env` added to `.gitignore`); `cloudflared`
    service gated behind a `tunnel` compose profile — public HTTPS/WSS entry point without
    exposing the gateway on the VM's public interface or fighting Oracle's security-list UI.
  - **`scripts/deploy-up.sh`** (new): one-line wrapper — `docker compose -f
    docker-compose.prod.yml --profile tunnel up -d --build`, with a `.env`-missing guard.
  - **`DEPLOY.md`** (new runbook): the L7b steps — provision the Always-Free ARM VM, install
    Docker, create the Cloudflare Tunnel + route it to `http://gateway:8080`, fill `.env`,
    `deploy-up.sh`, deploy `frontend/` to Vercel pointed at the tunnel hostname, then verify
    the L7 gate (public write, remote failover, reboot survival) against the real VM.
  - **Gate evidence (L7a, local):** `docker compose -f docker-compose.prod.yml build` — all 4
    prod images build. `up -d` (no tunnel profile) — 3 replicas + gateway all **healthy**;
    `docker exec replica1 whoami` → **`node`** (non-root confirmed). Leader elected
    (replica2, term 4). `POST /client-write` directly to the leader → `{"success":true}`,
    `cluster-status` showed leader `commitIndex` 0→1. **Reboot/volume proof:** `docker
    restart` replica1 → logs show clean `shutdown`(SIGTERM)→`node_stop`, then on boot
    reloaded **`term=4`** (not reset to 0) and replayed the applied entry from the named
    volume before rejoining; won re-election at term 5 after restart, and all 3 replicas
    re-converged on `commitIndex=1` with identical state (**no data lost across a container
    restart backed by a named volume, the reboot-survival property this layer needs**).
    `npm test` green in all three services (replica 105/105, gateway 65/65, frontend 41/41 —
    no app code changed, regression check only). `git status` confirmed no `.env`/secret
    staged (**RESULT: PASS** for the locally-verifiable portion of the gate).
  - **Bug caught during verify, not by static review:** a named volume mounted over a path the
    image doesn't already own is created root-owned by Docker; the non-root runtime container
    hit `EACCES` on `state.json` on first boot. Fixed in the Dockerfile (see above), logged in
    D18.
  - **L7b still open (needs the user, tracked as this layer's remaining step, not a new
    layer):** provision the real Oracle VM, create the Cloudflare Tunnel, deploy the frontend
    to Vercel, and verify the plan's actual stated gate — "cluster live at a public URL;
    failover + catch-up demoable remotely; state survives a VM reboot" — against the live
    infrastructure. `DEPLOY.md` has the exact steps.
- Prior: Layer 6 (Security hardening) COMPLETE. Gate passed (evidence below).
  - **Gateway-only auth boundary** (D17): new `gateway/src/security.ts` —
    `tokensMatch(provided, expected)` (constant-time via `crypto.timingSafeEqual`, length-
    guarded first; `expected === null` means auth disabled) and `validateStroke(stroke, conn)`
    (shape/bounds + identity binding). `wsServer.ts`'s connection handler reads `?token=` from
    the WS URL and closes (`1008 Unauthorized`) before any other check when it doesn't match
    `AUTH_TOKEN`; `index.ts` requires `Authorization: Bearer <token>` on `/cluster-status` (401
    without it), `/health` stays open (liveness). `gateway/src/index.ts` refactored into an
    exported `createGatewayServer(config)` factory (mirrors replica's `createApp`) so the HTTP
    surface is unit-testable without binding a real port at import time.
  - **Identity-bound stroke validation** (D17): `messageHandler.ts`'s `handleStroke` now calls
    `validateStroke`, which rejects a stroke whose `boardId`/`userId` doesn't match the sending
    connection — closes cross-board/identity forgery — plus shape/bounds checks (hex color,
    finite width, `points` capped at `maxStrokePoints=2000`, finite timestamp, valid `action`).
    Rejected strokes never reach `raftClient.submitStroke`.
  - **Per-connection rate limit**: fixed-window counter on `ConnectionInfo`
    (`strokeCount`/`windowStart`), 60 strokes/sec default (`GATEWAY_SECURITY` in `config.ts`);
    overflow gets a `RATE_LIMITED` error and is dropped before Raft, window resets on roll.
  - **CORS allowlist**: `index.ts`'s `writeCors` echoes `Origin` only when it's in
    `ALLOWED_ORIGINS` (`Vary: Origin`), or when the list explicitly opts out with `*` — replaces
    the previous blanket `Access-Control-Allow-Origin: *`.
  - **WS frame cap**: `WebSocketServer` now takes `maxPayload: 64KB` (`maxWsPayloadBytes`).
  - **Frontend**: `VITE_AUTH_TOKEN` → `constants.ts` `AUTH_TOKEN`; `useWebSocket.ts` appends
    `&token=` to the WS URL; `Dashboard.tsx` sends `Authorization: Bearer` on `/cluster-status`.
    Documented caveat: this token is baked into the public JS bundle — coarse admission control,
    not a per-user secret (no account model exists; named as out of scope).
  - **Gate evidence:** `tsc --noEmit` clean (gateway + replica + frontend). `npm test` green —
    gateway **65/65** (42 prior + 23 new: `security.test.ts` for `tokensMatch`/`validateStroke`
    incl. timing-safe length-mismatch and identity-forgery cases, `httpServer.test.ts` for
    `/cluster-status` 401/200/open-when-unset and CORS allowlist echo, `wsServer.test.ts` +2 for
    WS reject (`1008`) / accept-with-token, `messageHandler.test.ts` +3 for identity-forgery
    rejection, oversized-points rejection, and rate-limit overflow **[the property this layer
    exists to add]**), replica **105/105**, frontend **41/41** unaffected. Docker e2e
    (`docker compose up`, `AUTH_TOKEN=dev-demo-token` in compose, all 5 containers healthy):
    `GET /health` → 200 with no token; `GET /cluster-status` → **401** with no/wrong bearer,
    **200** with the correct one. WS connect with no/wrong `token` → accepted at the TCP/HTTP
    upgrade level then **closed 1008** immediately (matches the existing `boardId`/`userId`
    rejection pattern in this codebase); WS connect with the correct token → `join_ack`. A
    well-formed stroke committed normally (leader `commitIndex` advanced); a stroke claiming a
    **different `boardId`** than the connection was rejected client-side with `"Stroke
    boardId/userId must match connection"` and never reached Raft (commitIndex unchanged by
    it). A burst of **65** strokes from one connection: **60 accepted, exactly 5**
    `RATE_LIMITED` (**RESULT: PASS**).
- Prior: Layer 5 (Observability & lifecycle) COMPLETE. Gate passed (evidence below).
  - **Prometheus `/metrics`** (D16): new `replica/src/metrics.ts`, hand-rolled text exposition
    (no new dependency). Gauges (`raft_state`, `raft_current_term`, `raft_commit_index`,
    `raft_last_applied`, `raft_log_length`) read live from the existing `RaftNode.getStatus()`
    at scrape time; two counters (`raft_elections_started_total`, incremented in
    `becomeCandidate`; `raft_leadership_changes_total`, incremented in `becomeLeader`); one
    fixed-bucket (`5/10/25/50/100/250/500/1000`ms) `raft_write_latency_ms` histogram, observed
    in `handleClientWrite` on a successful majority commit. Wired via a new `/metrics` route in
    `rpcHandlers.ts`.
  - **`/ready` vs `/health`** (D16): `/health` unchanged (liveness — process up). New
    `RaftNode.isReady()` = `state === Leader` OR (`state === Follower` AND `leaderId !== null`)
    — "joined a functioning cluster", not a replication-lag threshold (L4's synchronous
    `applyCommitted()` means `lastApplied` always equals `commitIndex` between commits, so a
    lag-based definition would never gate anything). New `GET /ready` in `index.ts` → 503 when
    not ready, 200 + `{ready, state, leaderId}` otherwise.
  - **Graceful shutdown**: `index.ts` keeps the `http.Server` handle from `app.listen`; SIGTERM
    and SIGINT handlers call `raftNode.stop()` (halts election + heartbeat timers) then
    `server.close(() => process.exit(0))`. No flush step needed — L1's WAL/`state.json` are
    fsynced on every mutation already, so there is no in-memory buffer to lose.
  - **Gate evidence:** `tsc --noEmit` clean (replica). `npm test` green — replica **105/105**
    (101 prior + 4 new in `tests/replica/metrics.test.ts`: `/metrics` exposes all gauge/counter/
    histogram names, a latency observation lands in every bucket ≥ its value and bumps
    sum/count, `/ready` returns 503 for a fresh leaderless follower and 200 once the node
    becomes leader **[the property this layer exists to add]**), gateway **42/42**, frontend
    **41/41** unaffected. Docker e2e (`docker compose up`, 3 replicas + gateway + frontend all
    healthy): `curl replica2:3002/metrics` (the elected leader) returned scrapeable Prometheus
    text; a committed write (`POST /client-write`) advanced `raft_commit_index` 0→1 and recorded
    34ms in the latency histogram (`_count`=1, `_sum`=34, `bucket{le="1000"}`=1). `docker stop`
    (SIGTERM) the leader → logs show clean `shutdown`→`node_stop` (no forced kill needed);
    replica1 won a new election (term 5) — its `/metrics` showed `raft_state`→2 and
    `raft_leadership_changes_total`→1 with `raft_current_term`→5, `commitIndex=1` preserved
    (**no data lost**). `docker start` the stopped replica2 → rejoined at term 5 (not reset to
    0), caught up to `commitIndex=1`, `/ready` returned 200 (**RESULT: PASS**).
- Prior: Layer 4 (Backpressure & single replication driver) COMPLETE. Gate passed
  (evidence below).
  - **Single guarded replication driver** (D15): the three previously-duplicated replication call
    sites (`sendHeartbeats`, `syncCommittedEntries`, `handleClientWrite`'s per-write loop) collapse
    into one `RaftNode.replicateOnce(peer)`, wrapped by `driveReplication(peer)` — a
    `Map<string, Promise<void>>` of in-flight sends per peer. A second caller targeting a peer
    already mid-send awaits the same promise instead of racing a duplicate AppendEntries
    (`replication_coalesced` logged); `nextIndex`/`matchIndex` are now only ever mutated inside one
    drive per peer at a time, closing the heartbeat-timer-vs-client-write race (audit backlog #5).
    `syncCommittedEntries` is deleted — a backed-off peer's `nextIndex` is simply picked up by the
    next drive. `handleClientWrite`'s ack-counting switched from the calling RPC's own result to
    reading `matchIndex` directly — correct regardless of which caller's drive actually advanced a
    coalesced peer.
  - **AppendEntries batch cap** (D15): `replicateOnce` slices
    `getEntriesFrom(nextIdx).slice(0, this.batchCap)` — new `batchCap` ctor param, default
    `RAFT_TIMING.appendEntriesBatchCap = 128`, overridable via `APPEND_ENTRIES_BATCH_CAP` env
    (mirrors L2's `SNAPSHOT_THRESHOLD` pattern) — bounding RPC payload/memory for a far-behind
    follower instead of sending the whole log tail in one message (audit backlog #4).
  - **Gate evidence:** `tsc --noEmit` clean (replica + gateway). `npm test` green — replica
    **101/101** (98 prior + 3 new in `tests/replica/backpressure.test.ts`: a single AppendEntries
    is capped at the configured limit **[the property this layer exists to add]**, a follow-up
    drive resumes from the advanced `nextIndex` until fully caught up, and a concurrent heartbeat +
    client-write to the same peer coalesce onto one in-flight send rather than racing — verified
    via a concurrency counter in the mock RPC client), gateway **42/42**, frontend **41/41**
    unaffected. Docker e2e (`docker compose up`, 3 replicas + gateway healthy, temporary
    `APPEND_ENTRIES_BATCH_CAP=3` to force multi-batch, reverted after): fired 15 sequential writes
    directly at the leader (`POST /client-write`) — **15/15 succeeded**, all 3 replicas converged
    on `commitIndex=15` with identical board state; replica1's logs show **36
    `replication_coalesced` events** during the burst (heartbeat and client-write both targeting
    the same peer concurrently — the race this layer closes) and **zero**
    `append_entries_mismatch`/`sync_committed_retry` churn, with `commit_advance` progressing
    cleanly 1→15 (**RESULT: PASS**).
- Prior: Layer 3 (Correct reads + explicit leader redirect) COMPLETE. Gate passed
  (evidence below).
  - **ReadIndex** (D13): new `RaftNode.confirmLeadership()` sends the existing `/heartbeat` RPC
    to all peers and requires a majority of same-term acks (self + peers) before a read is
    trusted; any higher-term reply steps the node down. New `RaftNode.readBoardState(boardId)`
    records `commitIndex`, calls `confirmLeadership()`, and only then returns
    `getStrokes(boardId)` — `applyCommitted()` already runs synchronously on every commit
    advance so `lastApplied` is caught up by the time the heartbeat round resolves, no wait loop
    needed. `GET /board-state` (`rpcHandlers.ts`) is now `async`; on refusal (not leader, or
    unconfirmed) it replies **421 Misdirected Request** + `{ leaderHint }`, distinct from a
    confirmed-empty board (200, `strokes: []`). Known, documented (not fixed) bound: a
    freshly-elected leader's `commitIndex` can briefly lag the true committed index until its
    first current-term commit — never wrong data, never a stale-from-superseded-leader read,
    self-closing within the next write; no-op-on-election is the named upgrade path.
  - **Explicit leader address** (D14): new `RaftNode.leaderAddr` (URL) tracked alongside the
    existing `leaderId` (name, kept for `/status`/logs/dashboard). Sourced from a new
    `advertisedUrl` config field / `ADVERTISED_URL` env (default `http://${replicaId}:${port}`,
    already matches docker-compose's peer-URL convention — no compose changes needed).
    `AppendEntriesArgs`/`HeartbeatArgs` carry an optional `leaderAddr` the leader stamps on every
    RPC; followers copy it. `handleClientWrite`'s not-leader reply, `readBoardState`'s refusal,
    and `requestCatchUp`'s target selection now use `leaderAddr` directly — the old
    `peers.find(p => p.includes(leaderId))` substring match is gone. Gateway
    `remoteRaftClient.ts`: `submitStroke`'s hint-follow uses the URL directly (no `.find`);
    `getStrokes` gained `tryGetStrokes`/`getRaw` to distinguish 200 (confirmed) from 421
    (follow `leaderHint` one hop, then fall through to the next peer).
  - **Gate evidence:** `tsc --noEmit` clean (replica + gateway). `npm test` green — replica
    **98/98** (93 prior + 5 new in `tests/replica/readIndex.test.ts`: confirmed-leader read,
    minority-partitioned-leader refusal **[the property this layer exists to add]**,
    higher-term-ack step-down, follower redirect carries the URL not a name), gateway **42/42**
    (41 prior + 1 new: `getStrokes` follows a 421 `leaderHint` URL to the real leader), frontend
    **41/41** unaffected. Two pre-existing tests updated for the new behavior/shape
    (`health.test.ts` `parseConfig` shape, `raftNode.test.ts` leaderHint-is-now-a-URL,
    `integration.test.ts` catch-up test sets `leaderAddr` not `leaderId`). Docker e2e
    (`docker compose up`, 3 replicas + gateway all healthy): wrote a stroke directly to the
    leader (replica1) — `GET /board-state` on replica1 returned **200** with the stroke;
    the same request on a follower (replica2) returned **421** `{"leaderHint":
    "http://replica1:3001"}` — an explicit URL, not a name. `docker network disconnect` fully
    partitioned replica1 (old leader) from the cluster and from the host; replica2 won a new
    election (term 4) and served the committed write. Queried replica1 from *inside its own
    container* (loopback, so its own local state was reachable) while still partitioned:
    `GET /board-state` returned **421 Misdirected Request** — the partitioned leader refused to
    serve its stale-authoritative view, confirming ReadIndex's majority-heartbeat check failed
    as designed. Reconnected replica1 — it rejoined, won re-election (term 5), and all 3
    replicas converged on `commitIndex=1` with no data lost (**RESULT: PASS**).
- Prior: Layer 2 (Snapshot & log compaction) COMPLETE.
  - `replica/src/raftLog.ts` reworked to be offset-addressed: `lastIncludedIndex`/
    `lastIncludedTerm` seeded from a loaded snapshot; `getEntry`/`getLastIndex`/
    `getEntriesFrom`/`truncateFrom` all offset-adjusted; new `getTermAt` (term at an index
    including the boundary itself), `compact(uptoIndex, term)`, `installSnapshot(...)`.
  - `persistence.ts`: `Snapshot` type (`lastIncludedIndex/Term` + per-board event lists) moved
    to `types.ts` to avoid a circular import; `FilePersistence` adds `snapshot.json` via the
    existing atomic-write primitive; `MemoryPersistence` no-ops.
  - `raftNode.ts`: restores board state + `lastApplied`/`commitIndex` from a loaded snapshot on
    construct (before log replay); `maybeSnapshot()`/`takeSnapshot()` triggered at the end of
    every `applyCommitted()` once `commitIndex - lastIncludedIndex >= snapshotThreshold` (new
    6th ctor param, defaults to `RAFT_TIMING.snapshotThresholdEntries`); snapshot persisted
    **before** `log.compact()` so a crash between the two loses nothing.
  - New **InstallSnapshot RPC** (`types.ts`, `rpcClient.ts`, `rpcHandlers.ts` `/install-snapshot`):
    leader pushes it from `sendHeartbeats`/`syncCommittedEntries`/`handleClientWrite` when a
    peer's `nextIndex` falls at/below the compaction boundary; a follower's own `requestCatchUp`
    (cold-start path) also pulls it via an extended `SyncLogResult.snapshot` field. Both funnel
    through one shared `applySnapshot()`.
  - `config.ts` adds `snapshotThresholdEntries: 500` + `SNAPSHOT_THRESHOLD` env override;
    `docker-compose.yml` sets it to `20` per replica for demoability.
  - **Bug caught by the e2e gate, not unit tests:** the leader-side `prevLogTerm` computation at
    4 call sites still read `getEntry(idx).term`, which correctly returns `undefined` once the
    leader's own log compacted past that index — silently sent `prevLogTerm: 0`, followers
    rejected forever (`append_entries_mismatch` looping). Fixed by switching all 4 sites to the
    new `getTermAt`. Logged as D12.
  - **Gate evidence:** `tsc --noEmit` clean; `npm test` green — replica **93/93** (88 prior + 5
    new in `tests/replica/snapshot.test.ts`: bounded log after threshold, snapshot+tail recovery
    on restart, offset correctness across the compaction boundary, AppendEntries consistency at
    the boundary, wiped-follower InstallSnapshot + tail), gateway **41/41**, frontend **41/41**
    unaffected. Docker e2e (`SNAPSHOT_THRESHOLD=20`): drove 30 committed strokes to the leader →
    all 3 replicas reached `commitIndex=30`, on-disk `log.jsonl` bounded to **10 lines** (not
    30) with `snapshot.json` present on each host bind mount; `docker rm -f` replica3 + wiped its
    instance dir + restarted → logs show `install_snapshot_applied(lastIncludedIndex=20)` then
    `catch_up_done(logLength=10, commitIndex=30)` — recovered via snapshot + tail, not full
    replay; board state (30 strokes) identical across all 3 replicas (**RESULT: PASS**).
- Prior: Layer 1 (Durable persistence) COMPLETE.
  - New `replica/src/persistence.ts`: `Persistence` interface, `FilePersistence` (JSONL WAL +
    fsynced `state.json` holding `{currentTerm, votedFor, commitIndex}`, atomic temp-file +
    rename + dir-fsync, torn-tail-tolerant loader), `MemoryPersistence` default (D11).
  - `raftLog.ts` takes `Persistence`, seeds from `loadLog()`, fsyncs on `append`/`truncateFrom`.
  - `raftNode.ts` takes `Persistence` (5th, defaulted ctor param); loads
    `{currentTerm, votedFor, commitIndex}` + replays board state on construct; new
    `persistState()` fsyncs before every RPC reply that depends on the change —
    `becomeFollower`, `becomeCandidate`, `handleRequestVote` (the no-double-vote seam), and
    every commit-index advance (`updateCommitIndex`, `handleAppendEntries`, `handleHeartbeat`,
    `requestCatchUp`).
  - `config.ts` adds `DATA_DIR`; `index.ts` wires `FilePersistence` when set;
    `docker-compose.yml` sets `DATA_DIR=/app/instance` for replica1..3 (existing bind mount).
  - **Gate evidence:** `tsc --noEmit` clean; `npm test` green — replica **88/88** (81 prior +
    7 new: `persistence.test.ts` state/WAL roundtrip + atomic rewrite + torn-tail, plus
    `crashRecovery.test.ts` crash-recovery identity and no-double-vote-across-restart, which
    fails without this change), gateway **41/41**, frontend **41/41** unaffected. Docker e2e:
    `docker compose up` all healthy; stroke committed to all 3; `docker kill -9` on replica2
    mid-cluster; second stroke still committed via replica1+replica3 majority; `state.json` +
    `log.jsonl` confirmed on the host bind mount; `docker start` replica2 → reloaded
    `currentTerm=4` (did not reset to 0), caught up the missed write, board state correct
    (**RESULT: PASS**).
- Prior: Layer 0 (Baseline & cleanup) COMPLETE.
  - Cluster 4→3 replicas: `docker-compose.yml`, peer lists, gateway `RAFT_PEERS`, deleted
    `replica4/`; updated README, Documentation.md, and both demo scripts (no `replica4`/`3004` refs left).
  - Removed placeholder `replica{1..4}/README.md`; gitignored `replica1..3/` instance dirs (D10).
  - Added per-service config modules `replica/src/config.ts` (`RAFT_TIMING` + `parseConfig`) and
    `gateway/src/config.ts` (`GATEWAY_TIMING` + `parseGatewayConfig`); rewired electionTimer,
    rpcClient, index, wsServer, remoteRaftClient to source all tunables there (D08).
  - Pinned every dependency to exact lockfile-resolved versions across all 3 services (D09);
    lockfiles synced; `npm ci` succeeds in each (proves lock-consistency).
  - Governance docs committed earlier; repo remote repointed to `QuorumCanvas`.
  - **Gate evidence:** `tsc --noEmit` clean (replica+gateway); `npm test` green — replica **81/81**,
    gateway **41/41**, frontend **41/41**; `docker compose up` → all 5 containers **healthy**;
    e2e: leader elected (replica1, term 3), stroke broadcast to a second WS client and
    committed+replicated to follower replica2 (**RESULT: PASS**).
- Prior: Governance layer + full Raft correctness audit (election restriction & current-term
  commit rule already correct — DECISIONS D02, interview assets).

## Next up
- **All 9 build layers complete.** No further layers planned in `PROJECT_PLAN.md`. Remaining work
  is operational: tear down the GCP VM (below) and, if desired, capture live-deployment
  screenshots for the résumé/portfolio before doing so.
- **Reminder**: the GCP VM is running against the **90-day free trial** (see D19) — delete the
  instance (`gcloud compute instances delete mini-raft --project=mini-raft-prod
  --zone=asia-south1-a`) once done demoing/benchmarking to stop credit burn, per `DEPLOY.md`.
  Still up as of L8 (benchmarked against it); leave it up if L9's README work will also want to
  screenshot/reference the live deployment, otherwise tear down.

## Prioritized defect backlog (from the audit)
1. ~~**[CRITICAL]** No durable persistence — restart → term 0 / votedFor null → double-vote →
   split-brain / lost commits.~~ → **FIXED in L1** (D11).
2. ~~**[HIGH]** No snapshot / log compaction — unbounded log, full replay on restart.~~ →
   **FIXED in L2** (D12).
3. ~~**[HIGH]** Stale reads on minority-partition leader (no ReadIndex/lease).~~ → **FIXED in
   L3** (D13).
4. ~~**[MED]** Unbounded AppendEntries payload (no batch cap / backpressure).~~ → **FIXED in
   L4** (D15).
5. ~~**[MED]** `nextIndex`/`matchIndex` race between heartbeat timer and `handleClientWrite`.~~ →
   **FIXED in L4** (D15).
6. ~~**[LOW]** Leader hint is a name matched by `url.includes()` — fragile.~~ → **FIXED in L3**
   (D14).
7. **[LOW]** 4 replicas (even quorum) — move to 3. → **L0**

Non-Raft hardening tracked in later layers: observability/metrics + graceful shutdown (**L5**),
auth/authz/validation/rate-limit/CORS/TLS (**L6**), deploy (**L7**), benchmarks (**L8**),
defense pack + README (**L9**).

## Open questions
- GCP free trial is a **90-day window** (D19) — if the demo/interview season runs longer than
  that, the VM needs re-provisioning (new trial or paid upgrade, ~$25-36/mo for `e2-small`).
- Snapshot cadence (L2) and AppendEntries batch cap (L4) values to be tuned against L8 benchmarks.

## How to resume
1. Read `CLAUDE.md` §2 (PRIME DIRECTIVE) and §4 (constraints).
2. Read `PROJECT_PLAN.md` §5 for the current layer's scope + Acceptance Gate.
3. Do exactly that one layer, run its gate, update `DECISIONS.md` + this file, then STOP and
   ask before the next layer.
