# DECISIONS.md — Mini-RAFT

> Every non-trivial choice, logged so it can be defended in an interview.
> Newest entries at the top. Do not silently edit old entries — supersede with a new one that references them.

## Entry template

```
### D<NN> — <short title>
- Date:
- Context: what problem/choice prompted this.
- Decision: what we chose.
- Why: the reasoning.
- Alternatives considered: what else, and why not.
- Tradeoffs / risks: what we give up or must watch.
- Supersedes: D<xx> (if any).
```

---

### D24 — Dev `docker-compose.yml` broken by L7a's multi-stage Dockerfile rewrite; fixed with `target: build`
- Date: 2026-07-21
- Context: bringing the local cluster up to run L8's benchmark harness, `docker compose up
  --build` failed — `replica1` (and, on inspection, `gateway`) never went healthy, logs showing
  `sh: tsx: not found`. Root cause: L7a (D18) rewrote `replica/Dockerfile` and `gateway/Dockerfile`
  into multi-stage builds — a `build` stage with `npm ci` (all deps, incl. `tsx`) and `src/`, and
  a slim `runtime` stage with `npm ci --omit=dev` and only compiled `dist/`. `docker-compose.yml`
  (dev) still does plain `build: ./replica` with `command: npm run dev` (which shells out to
  `tsx watch`) and bind-mounts `./replica:/app` for live-reload — but an unqualified multi-stage
  build produces the **last** stage (`runtime`), which has neither `tsx` nor `src/`. This was a
  real regression introduced in L7a that the L7a/L7b gates never caught, because neither ran
  `docker compose up` against the *dev* compose file after the Dockerfile rewrite.
- Decision: added `target: build` to the `build:` stanza for `replica1`/`replica2`/`replica3`/
  `gateway` in `docker-compose.yml` only. `docker-compose.prod.yml` is untouched — it has no
  `target`, so it correctly still resolves to the final `runtime` stage.
- Why: root-cause fix in the shared compose config each service inherits, not a workaround
  (e.g. reinstalling `tsx` at runtime). The `build` stage already has exactly what dev mode
  needs (full deps + source); pinning `target` is the standard Compose mechanism for a
  multi-stage Dockerfile serving two different consumers.
- Alternatives considered: a separate `Dockerfile.dev` per service (more files to keep in sync,
  no real benefit over `target:` since the existing `build` stage is already dev-shaped);
  reverting the multi-stage Dockerfile (would undo L7a's non-root/slim-runtime prod hardening).
- Tradeoffs / risks: none — dev and prod build paths are now both correct and explicit about
  which stage they want; if a Dockerfile ever drops the `build` stage's name this breaks loudly
  at `docker compose up` (a build reference error), not silently.
- Supersedes: none (L7a's D18 stands; this is a fix for a gap D18 left, in dev tooling only).

---

### D23 — L8 benchmark harness: zero-dependency `benchmarks/bench.mjs`, measured directly against a replica's `/client-write`
- Date: 2026-07-21
- Context: `PROJECT_PLAN.md` §7 wants four measured/published numbers (leader-election/failover
  time, write throughput, commit-latency p50/p99, partition behavior), with the L8 gate requiring
  reproducible numbers committed to the repo, on both the local dev cluster and the live GCP
  deployment.
- Decision: one dependency-free `benchmarks/bench.mjs`, run via plain `node`, using only
  `fetch`/`node:perf_hooks`/`node:os`/`node:child_process` — no `k6`, no new npm package, no
  build step. `load` fires a fixed-shape/fixed-count batch of writes at a bounded concurrency
  directly at the current leader's `/client-write` (this endpoint has no auth — L6 auth is
  gateway-only — and only replies `success:true` after majority commit, so timing it is exactly
  the "client submit → majority commit" latency §7 asks for, with no WS/tunnel noise in the
  measurement). `failover` times `docker compose stop <leader>` → a new leader elects and commits
  a write, then restarts the stopped container so the cluster is left whole. Partition behavior
  (§7 #4) is left to the existing `scripts/test-network-partition.sh` rather than re-implemented
  here — it's a pass/fail behavioral property, not a percentile, and is already proven live.
  Params default to fixed values (`writes=2000`, `concurrency=16`, fixed stroke payload) so a
  re-run lands in the same ballpark; every run appends params + machine spec + results to
  `benchmarks/results/*.md`.
- Why: matches the existing ops-tooling convention in this repo — `scripts/*.sh` is already
  plain bash, not TypeScript, for the same reason (throwaway/one-shot operational scripts, not
  code defended file-by-file in the interview the way `replica/`/`gateway`/`frontend` are).
  Zero dependencies means the harness runs identically on a fresh GCP VM with nothing but a
  Node binary present — no `npm ci`, no TypeScript toolchain, consistent with D20's decision to
  keep the VM free of the build toolchain entirely.
- Alternatives considered: `k6` (real load-testing tool, but a new dependency/binary to install
  on the VM for one metric set); a TypeScript `bench.ts` run via `tsx` (honors "TypeScript
  throughout" literally, but adds a dev dependency + run wrapper for what is ops tooling, and
  breaks from the bash-script precedent already in `scripts/`); measuring through the gateway/WS
  path instead of the replica directly (would conflate Raft commit latency with gateway
  auth/validation/WS overhead — a different, also-useful number, but not what §7 #3 is asking for).
- Tradeoffs / risks: `load`'s promise-pool concurrency model is a simple bounded-parallel loop,
  not a proper open/closed-loop load generator — fine for this project's scale and honest as a
  "committed writes/sec at N concurrent clients" number, not a claim of finding the cluster's
  absolute ceiling. `failover`'s measured window includes the harness's own polling granularity
  (findLeader polls every 500ms), so the reported `failoverMs` is an upper bound on the true
  election+catch-up time, not a sub-millisecond-precise figure — acceptable given the target is
  "sub-second to low-seconds," not a tight SLO.
- Supersedes: none.

---

### D22 — Gateway `UV_THREADPOOL_SIZE=16`: fix `/cluster-status` false-unhealthy during a real peer outage
- Date: 2026-07-20
- Context: running L7b's live failover gate (stop the leader container, confirm the dashboard
  and writes behave correctly) surfaced a real bug: `GET /cluster-status` reported **every**
  peer — including the two still-healthy ones — as unhealthy with `"This operation was
  aborted"` whenever exactly one peer was down. Directly querying the healthy replicas'
  own `/status` (bypassing the gateway) showed the Raft core was fine throughout — new leader
  elected, `commitIndex` advancing correctly — so this was purely a gateway status-aggregation
  defect, not a consensus bug. Root cause, isolated by `docker exec`ing into the gateway
  container and timing a raw `wget` to the down peer's Docker DNS name: the base image's musl
  libc resolver takes **~5s** to return NXDOMAIN for a *stopped* (not just refused) peer
  hostname. `clusterStatus.ts`'s per-peer fetches each have their own 1500ms
  `AbortController` timeout and are already correctly isolated per-peer in code — but Node's
  `fetch`/`dns.lookup` resolves hostnames via libuv's threadpool (default size 4), and the
  down peer's two slow lookups (health+status) tied up threads long enough to delay the
  concurrently-issued, otherwise-fast lookups for the healthy peers past their own 1500ms
  budget too — a shared-resource starvation across independent requests, not a bug in the
  per-peer timeout/error-handling logic itself.
- Decision: set `UV_THREADPOOL_SIZE: "16"` on the `gateway` service's environment in
  `docker-compose.prod.yml`. Re-verified live by stopping the leader a second time: the
  dashboard correctly showed the down peer as unhealthy while the two healthy peers reported
  accurate state.
- Why: the standard, minimal, well-documented mitigation for libuv threadpool starvation from
  slow DNS/getaddrinfo calls (a known Node-on-Alpine/musl class of issue) — one env var, no
  application code change, no behavior change for the already-correct per-request
  timeout/error-isolation logic in `clusterStatus.ts`.
- Alternatives considered: lowering `STATUS_TIMEOUT_MS` (wrong direction — the healthy peers'
  requests were already fast; the problem was never getting a thread in time to run, not a
  slow response once running); switching to a DNS-caching resolver or pre-resolving peer IPs
  (heavier change, not needed once the threadpool bottleneck is removed); ignoring it as
  cosmetic (rejected — a dashboard that reports the whole cluster down during a single-node
  outage is actively misleading in exactly the demo scenario the dashboard exists for).
- Tradeoffs / risks: slightly higher memory/thread overhead on the 2GB VM from more OS threads
  (negligible at this scale — the gateway is I/O-bound, not CPU-bound). This is a
  container-runtime tuning knob discovered under real infrastructure, not something the local
  Docker Desktop dev loop or the L7a local-verify gate exercised (the local gate never stopped
  a peer's *container* the way the live L7b failover gate did) — worth carrying into the dev
  compose file too if this recurs there, not done here since out of L7b's scope.
- Supersedes: none.

---

### D21 — Two smaller L7b problems hit while running the live gate (compose profile validation; wrong write endpoint)
- Date: 2026-07-20
- Context: two more concrete "what went wrong / how fixed" incidents from the live L7b bring-up,
  worth keeping alongside D19-D20/D22 as interview material even though neither needed much
  design discussion.
- Problem 1 — **`docker compose` validates every service's env vars regardless of `--profile`**.
  `docker-compose.prod.yml`'s named-tunnel `cloudflared` service required `TUNNEL_TOKEN` via
  `${TUNNEL_TOKEN:?...}`. Running `./scripts/deploy-up.sh quicktunnel` (which never starts that
  service) still failed at the compose-file-parsing stage with `required variable TUNNEL_TOKEN
  is missing a value` — profile-gating only controls which services *start*, not which services'
  env interpolation gets validated. Fixed by relaxing to `${TUNNEL_TOKEN:-}` (the named-tunnel
  service still fails clearly at container startup if actually invoked without a real token, so
  nothing silently breaks for that path).
- Problem 2 — **tested the write path against the wrong endpoint at first**. `DEPLOY.md`'s
  original local gate examples (L1-L6) used `POST /client-write` directly against a *replica*
  for quick local testing. Assumed the same route existed on the *gateway* and tried it through
  the public tunnel — got back the gateway's plain-text fallback response (`"Mini-RAFT
  Gateway"`), not JSON. Reading `gateway/src/index.ts` showed the gateway's HTTP surface is only
  `/health`, `/cluster-status`, and CORS preflight — writes are **WebSocket-only**
  (`gateway/src/messageHandler.ts`), matching what the real frontend does. Fixed by writing a
  small WebSocket test client (`join` → `stroke`, same protocol as `useWebSocket.ts`) instead —
  this is also the *more correct* gate, since it exercises the actual client-facing protocol
  rather than an internal test-only route.
- Why these are worth keeping: both are "read the actual code / actual tool behavior instead of
  assuming" stories — the kind of debugging judgment call an interviewer asks about — even
  though each fix was small.
- Tradeoffs / risks: none beyond what's already noted (Problem 1's fix means a misconfigured
  named-tunnel run fails later, at container-start, instead of at compose-parse time).
- Supersedes: none.

---

### D20 — L7b image delivery: build+push locally to Artifact Registry; public entry: Cloudflare quick tunnel
- Date: 2026-07-20
- Context: D19 picked `e2-small` (2 vCPU/2GB) for L7b. `docker-compose.prod.yml` as written
  (`build: ./replica` / `./gateway`, invoked via `deploy-up.sh --build` on the VM) would run
  `npm ci`+`tsc` for the replica and gateway build stages concurrently on that same 2GB VM —
  real OOM/slowness risk on the smallest paid-adjacent shape. Separately, D19 assumed a named
  Cloudflare Tunnel per the original `DEPLOY.md`, but the user has never created a Cloudflare
  account, and a named tunnel's stable hostname needs one (plus a domain).
- Decision: (1) **Build both images locally** (Docker Desktop, already running on the user's
  laptop, confirmed reachable) tagged for **GCP Artifact Registry**
  (`asia-south1-docker.pkg.dev/mini-raft-prod/mini-raft/{replica,gateway}:latest`, one shared
  `replica` image reused by replica1-3 since they're the same Dockerfile/context), pushed
  before the VM ever runs. `docker-compose.prod.yml` gained `image:` tags alongside the
  existing `build:` (both kept — local iteration/dev still uses `build`); `deploy-up.sh` now
  `pull`s instead of `--build`s. The VM's only Artifact Registry credential is the attached
  service-account's metadata-server token via `docker login -u oauth2accesstoken` — no
  `gcloud` SDK install needed on the VM. (2) **Cloudflare quick tunnel** (new
  `cloudflared-quick` service, profile `quicktunnel`, `tunnel --url http://gateway:8080`, no
  `TUNNEL_TOKEN`) as the primary L7b public entry — zero account, zero cost, works today. The
  original named-tunnel service/profile is kept in the compose file and `DEPLOY.md` as a
  documented upgrade path if the user later gets a Cloudflare account + domain.
- Why: eliminates the VM as a build environment entirely (removes the single biggest RAM risk
  on a 2GB shape) and unblocks the public-URL requirement with the accounts the user actually
  has today.
- Alternatives considered: build-on-VM with a swap file (still slow/risky on 2GB, adds a step
  D19 specifically tried to avoid); Docker Hub as the registry (would need a separate free
  account — Artifact Registry reuses the already-authenticated `gcloud` session, zero new
  signup); named Cloudflare tunnel now (blocked — no account/domain today; kept as the
  documented upgrade, not deleted).
- Tradeoffs / risks: the quick-tunnel hostname is **ephemeral** — changes on every
  `cloudflared-quick` restart (including a VM reboot), requiring Vercel's env vars and the
  gateway's `ALLOWED_ORIGINS` to be re-pointed after any restart. This is an explicit, known
  ceiling of the token-free path (see `DEPLOY.md` §3/§6), not a bug; a named tunnel is the
  upgrade if URL stability becomes worth a domain purchase. Artifact Registry images are
  private by default — the VM's metadata-token login step is a new manual step in `DEPLOY.md`.
- Supersedes: none (refines D19's L7b execution, doesn't reverse the GCP/`e2-small` choice).

---

### D19 — L7b cloud target: GCP `e2-small` (asia-south1) on the free trial, not Oracle Always Free
- Date: 2026-07-20
- Context: D18 chose Oracle Cloud Always Free ARM as the L7b host. The user hit persistent
  Oracle signup/login friction blocking L7b. Re-examining the actual requirement: the cluster
  needs to be live at a public URL for a placement-interview season (provably deployed,
  demoable), not running forever — so "always-free" is not actually load-bearing, "free enough
  for ~3 months and reliably provisionable" is. The user already has GCP free-trial credits
  enabled.
- Decision: Host L7b on **GCP Compute Engine, machine type `e2-small` (2 vCPU/2GB), region
  asia-south1 (Mumbai)**, billed against the **$300/90-day free trial** (not a paid account).
  `docker-compose.prod.yml`, the Dockerfiles, Cloudflare Tunnel, and Vercel frontend steps are
  unchanged — only `DEPLOY.md` §1 (provisioning) and the free-tier notes were rewritten.
- Why: the trial credit is usable on any region/instance size, not just an always-free micro
  shape, so a real VM draws down credit the user already has (fastest path, no new signup).
  `e2-small`'s 2 GB RAM fits 3 replicas + gateway + `cloudflared` with headroom — avoids the
  swap-file workaround a 1 GB shape (Oracle's blocked path aside, or AWS t3.micro) would need.
  GCP does not auto-charge past the trial: it stops resources and closes the trial billing
  account instead, so there's no surprise-bill risk (CLAUDE.md §4). Estimated cost draw for a
  3-month demo window is ~$75-80 of the $300 credit — the 90-day window binds before the money
  does.
- Alternatives considered: **Oracle A1.Flex** (best always-free fit, 12GB RAM — but blocked on
  account access with no ETA); **AWS t3.micro** (new-account free plan gives $200 credit / up
  to 6 months, longer window than GCP's 90 days — but only 1 GB RAM, needs a swap file, and the
  user has no existing AWS credits); **Fly.io** (most authentic multi-machine Raft placement,
  named as the plan's original fallback — but real billing risk beyond tiny scale, no free
  credit safety net).
- Tradeoffs / risks: the **90-day trial window is shorter than AWS's 6-month new-account
  window** — if the demo/interview season runs longer, the instance must be re-provisioned (a
  new project's trial, or upgrade to paid, at ~$25-36/mo). `e2-small` is x86, not ARM (no
  functional impact — Docker images are Node-based and effectively multi-arch already). Not an
  always-free tier, so unlike Oracle this deployment is explicitly not meant to run
  indefinitely — must be deleted after use to stop credit burn, tracked as a manual step in
  `DEPLOY.md`.
- Supersedes: D18 (Oracle platform choice only — D18's compose/Dockerfile/Cloudflare/Vercel
  architecture decisions still stand and are reused as-is).

---

### D18 — L7a deployment topology: single Oracle VM, named-volume prod compose, Cloudflare Tunnel edge, Vercel frontend
- Date: 2026-07-19
- Context: L7 needs the cluster running at a public URL on free-tier compute only
  (CLAUDE.md §4). The existing `docker-compose.yml` is dev-only (source bind mounts, `npm run
  dev`, debug ports, root user) — not something to expose to the internet as-is. Also: the
  Vercel frontend is served over HTTPS, so a plain `http://`/`ws://` gateway would be
  mixed-content blocked by the browser — the public entry point must terminate real TLS.
  I (Claude) cannot sign up for Oracle (needs the user's card) or drive its console
  (VM/volume/firewall provisioning), so this decision also covers **splitting the layer**
  (CLAUDE.md §2.5): L7a = author + locally-verify every deploy artifact; L7b = the user runs
  the actual Oracle/Cloudflare/Vercel bring-up from `DEPLOY.md`, with me troubleshooting.
- Decision: (1) One Always-Free ARM VM (`VM.Standard.A1.Flex`, 2 OCPU/12GB) hosts all 3
  replicas + gateway as containers — per `PROJECT_PLAN.md` §6 this is the only free tier with
  real persistent disks for a stateful Raft cluster. (2) New `docker-compose.prod.yml`
  (dev compose untouched, kept for local iteration): multi-stage, non-root Dockerfiles
  (`npm ci` build stage → `npm ci --omit=dev` runtime stage, `USER node`), **named volumes**
  per replica (`replica<N>-data:/app/instance`) instead of bind mounts so `DATA_DIR` survives
  a VM reboot without depending on host filesystem layout, secrets/config sourced from a
  gitignored `.env` (`.env.example` committed as the template). (3) Public HTTPS/WSS entry via
  a `cloudflared` container (Cloudflare Tunnel, gated behind a `tunnel` compose profile so
  local verification doesn't need a real Cloudflare account) — the gateway itself stays off
  the VM's public interface entirely; only the tunnel is internet-reachable, sidestepping
  Oracle's security-list/NSG configuration for inbound app ports. (4) Frontend deploys to
  Vercel (zero-config Vite static build), pointed at the tunnel's HTTPS hostname.
- Why: named volumes are the simplest way to decouple `DATA_DIR` persistence from the exact
  bind-mount path chosen on an unknown VM, and Docker seeds a fresh named volume from the
  image directory's contents/ownership on first mount — letting the image itself pre-create
  `/app/instance` owned by the non-root `node` user (see below) rather than needing an
  entrypoint chown script. Cloudflare Tunnel over Caddy+Let's-Encrypt: no domain purchase, no
  inbound firewall rule to get right in Oracle's often-fiddly security-list UI, and it's free
  with no VM-side cert renewal to babysit.
- Alternatives considered: Caddy + a free DuckDNS subdomain (rejected — needs ports 80/443
  opened in both Oracle's security list and the VM's iptables, plus a subdomain to manage;
  more moving parts for the same outcome). systemd instead of compose for bring-up (rejected —
  compose already exists and works; the plan explicitly allows either, no reason to add a
  second orchestration mechanism). Fly.io (documented fallback only, per `PROJECT_PLAN.md` §6 —
  free allowance is a small PAYG budget that may bill; use only if Oracle ARM capacity is
  unavailable at signup).
- Tradeoffs / risks: Cloudflare Tunnel is a third-party dependency in the request path (an
  outage there takes the public cluster down even if the VM is healthy) — acceptable for a
  free-tier resume project, named as a caveat. A single VM is still a single point of physical
  failure for all 3 replicas (no cross-AZ/cross-VM fault tolerance) — Raft here defends
  against *process*-level failure (crash, leader loss, network partition between containers),
  not *host*-level failure; this matches the stated free-tier constraint, named honestly.
  `.env`-based secrets mean the deploy step is manual (not templated infra-as-code) — acceptable
  at this scale, revisit if the project ever needs multi-VM.
- Discovered during local verification: a named volume mounted at a path the image doesn't
  already own gets created root-owned, so the non-root (`USER node`) runtime container got
  `EACCES` writing `state.json` on first boot. Fixed by adding `RUN mkdir -p /app/instance &&
  chown node:node /app/instance` before `USER node` in the runtime stage — Docker copies that
  ownership into the volume on its first mount.

---

### D17 — Gateway-only auth boundary, shared bearer token, identity-bound stroke validation
- Date: 2026-07-19
- Context: L6 needs to close the public write path: no auth on gateway WS/HTTP, CORS wide open
  (`*`), and stroke validation only checked `stroke.id` truthy — a stroke could claim any
  `boardId`/`userId` regardless of the connection that sent it, and nothing capped payload size
  or write rate. Two open choices: where to enforce auth (gateway only vs. also on replica RPC),
  and what "ready" behavior should be when `AUTH_TOKEN` is unset (open vs. fail-closed).
- Decision: enforce auth **at the gateway only** — in the L7 deployment topology only the
  gateway port is public; replicas sit on the internal Docker/VM network, so network isolation
  is their boundary. A single shared bearer token (`AUTH_TOKEN`) gates both the WS handshake
  (`?token=` query param — browsers can't set custom headers on `WebSocket`) and HTTP endpoints
  (`Authorization: Bearer` header on `/cluster-status`; `/health` stays open for liveness
  probes). Compared with `crypto.timingSafeEqual` (length-guarded first, since it throws on a
  length mismatch) to avoid a timing oracle. Auth is **active only when `AUTH_TOKEN` is set** —
  unset means open (local dev keeps working with zero config; the deploy sets the token).
  Per-board authorization is **identity binding, not ACLs**: with no account model, a stroke's
  `boardId`/`userId` must equal the authenticated connection's, closing cross-board/identity
  forgery (a connection joined to board A could otherwise submit a write claiming board B or
  another user). Stroke shape/bounds are validated (hex color, finite width, points array
  capped at 2000, finite timestamp) and a fixed-window per-connection rate limit
  (60 strokes/sec) rejects overflow before it ever reaches Raft. CORS moved from `*` to an
  origin allowlist (`ALLOWED_ORIGINS`, echoed + `Vary: Origin`), with `*` still available as an
  explicit opt-out.
- Why: no user-account system exists in this project, so a single shared token is the correct
  minimal admission control — JWT would need an issuer/login story that doesn't exist yet. Hand-
  rolling validation/rate-limit matches the project's existing hand-roll ethos (WAL, Raft RPCs,
  Prometheus text, D16) and the actual surface is small. Gateway-only auth keeps the diff
  minimal and matches the real public attack surface; extending the token to replica RPC would
  add config plumbing to a boundary that's already closed by network isolation.
- Alternatives considered: JWT (rejected, no login story to justify it); per-replica auth too
  (rejected — replicas aren't publicly reachable in the L7 topology, so it adds surface without
  closing a real gap); fail-closed when `AUTH_TOKEN` unset (rejected — breaks tokenless local
  dev and the existing test suite for no safety gain in a dev-only context).
- Tradeoffs / risks: `VITE_AUTH_TOKEN` is baked into the public frontend JS bundle at build
  time, so it is **coarse admission control** (blocks non-browser/automated abuse, enforces the
  auth mechanism) — **not** a per-user secret; anyone who inspects the bundle can extract it.
  Genuine per-user auth needs real accounts, explicitly out of scope. The rate limit is a
  fixed-window per-connection counter (`ponytail`-simple) — a client can burst up to 2x the
  configured rate across a window boundary; a sliding window is the upgrade path if that
  matters at scale.

---

### D16 — Hand-rolled Prometheus exposition + joined-cluster readiness definition
- Date: 2026-07-19
- Context: L5 needs `/metrics` (state, currentTerm, commitIndex, log length, elections started,
  leadership changes, write latency) and a `/ready` endpoint distinct from `/health`. Two open
  choices: whether to pull in `prom-client`, and what "ready" means for a Raft node (no natural
  replication-lag signal exists here — `lastApplied` catches up to `commitIndex` synchronously
  inside `applyCommitted()` on every commit, so a lag-based readiness gate would always read 0).
- Decision: hand-rolled `replica/src/metrics.ts` emitting Prometheus text format directly — no
  new dependency. Only 3 series need in-process accumulation (`electionsStarted`,
  `leadershipChanges` counters; a fixed-bucket `[5,10,25,50,100,250,500,1000]`ms write-latency
  histogram); every gauge (`raft_state`, `raft_current_term`, `raft_commit_index`,
  `raft_last_applied`, `raft_log_length`) is read live from the existing `RaftNode.getStatus()`
  at scrape time, not shadow-tracked. `RaftNode.isReady()` defines readiness as "joined a
  functioning cluster": `state === Leader` OR (`state === Follower` AND `leaderId !== null`) —
  a candidate, or a follower that has never heard from a leader, is not ready. `/health` stays
  liveness-only (process up); `/ready` is the new joined-cluster gate, 503 when false.
- Why: the user chose hand-rolled over `prom-client` to match the project's hand-roll-the-core
  ethos (WAL, Raft RPCs) and because the actual metric surface is tiny — a real dependency buys
  correct histogram math we don't need at 3 series and default Node process metrics (CPU/mem/GC)
  that PROJECT_PLAN §L5 doesn't ask for. Joined-cluster (not lag-based) readiness is the only
  definition that's actually meaningful given L4's synchronous apply.
- Alternatives considered: `prom-client` (rejected — see above); readiness = `lastApplied ===
  commitIndex` (rejected — always true by construction post-L4, would not gate anything real).
- Tradeoffs / risks: hand-rolled exposition format must be kept in sync by hand if new metrics
  are added later (no library to enforce the format); no default process metrics (CPU/mem/GC) —
  acceptable, out of scope for L5's Raft-specific ask.

---

### D15 — Single guarded replication driver per peer + AppendEntries batch cap
- Date: 2026-07-19
- Context: `raftNode.ts` had **three** independent replication call sites hitting the same peer —
  `sendHeartbeats` (150ms timer), `syncCommittedEntries` (failure back-off retry), and
  `handleClientWrite` (per-write replication loop) — each reading `nextIndex`, building an
  `AppendEntriesArgs`, calling `appendEntries`, and mutating `nextIndex`/`matchIndex`
  independently. A heartbeat tick and a concurrent client write could both be in flight to the
  same peer at once, racing on those maps and double-sending overlapping entries (audit backlog
  #5). Separately, every one of those sites called `log.getEntriesFrom(nextIdx)` with **no
  cap** — a far-behind follower (wiped-node catch-up, or a write burst) could receive its entire
  log tail in one RPC, unbounded payload/memory (audit backlog #4).
- Decision: collapsed the three duplicated call sites into one `replicateOnce(peer)` — reads
  `nextIndex`, slices `getEntriesFrom(nextIdx).slice(0, this.batchCap)` (new `batchCap` ctor
  param, default `RAFT_TIMING.appendEntriesBatchCap = 128`, overridable via
  `APPEND_ENTRIES_BATCH_CAP` env — same pattern as L2's `SNAPSHOT_THRESHOLD`), sends
  AppendEntries (or InstallSnapshot if the peer has fallen behind the compaction boundary), and
  advances `nextIndex`/`matchIndex` by the slice actually sent (so a partial batch is picked up
  correctly by the next drive). A new `driveReplication(peer)` wraps it with a
  `Map<string, Promise<void>>` of in-flight sends: a second caller targeting a peer already
  mid-send **awaits the same promise** instead of issuing a duplicate RPC (`replication_coalesced`
  logged). Both `sendHeartbeats` and `handleClientWrite`'s retry loop now just call
  `driveReplication` for every peer; `syncCommittedEntries` is deleted — its job (resuming a
  behind peer) is now just "the next drive re-reads the backed-off `nextIndex`."
  `handleClientWrite`'s ack-counting changed from "did this call's own RPC succeed" to reading
  `matchIndex` directly after the drive — necessary because a coalesced peer's progress was
  recorded by whichever drive was actually in flight, not by this call.
- Why: one code path removes the duplication that caused the race by construction (a peer's
  `nextIndex`/`matchIndex` are now only ever mutated inside one drive at a time); reading
  `matchIndex` for acks is correct regardless of which caller's drive actually moved it, so
  coalescing is transparent to `handleClientWrite`'s majority count. The batch cap bounds RPC
  payload/memory without adding a new mechanism — it's the same slice-and-advance shape the
  existing partial-catch-up code already had.
- Alternatives considered: (a) a per-peer in-flight `Set` guard added to the *existing* three
  call sites, skipping a send if one's already outstanding — smaller diff, but leaves the
  duplication and still forces ack-counting through `matchIndex` anyway, so it gives up the win
  (one path to reason about) for no real savings; rejected. (b) a long-lived background
  replication loop per peer, decoupled from both the heartbeat timer and client-write calls
  (closer to a "real" Raft implementation's dedicated replicator) — more correct under high
  contention/pipelining, but a bigger structural change than this defect needs; named as the
  documented upgrade path if L8 benchmarks show the coalescing guard bottlenecking throughput,
  not built now.
- Tradeoffs / risks: only one AppendEntries in flight per peer at a time — no pipelining of
  multiple outstanding batches, so a very-far-behind follower catches up in serial capped
  batches rather than a flood (acceptable; catch-up isn't the hot path). `matchIndex`-based ack
  counting in `handleClientWrite` means a slow, unrelated in-flight heartbeat send can make a
  client write's first attempt appear to under-ack even though the entry hasn't been sent yet
  to that peer — closed by the existing 3-attempt retry loop, which re-drives on the next
  iteration once the coalesced send completes.

---

### D14 — Explicit leader address replaces name-substring redirect
- Date: 2026-07-19
- Context: `leaderHint`/`leaderId` was a replica *name* (`"replica1"`), and both the gateway
  (`remoteRaftClient.ts:41`, old code) and a restarting follower's `requestCatchUp` resolved it
  with `peers.find(p => p.includes(hint))` — fragile (`replica1` ⊂ a hypothetical `replica10`)
  and only worked because compose names happened to be unique prefixes.
- Decision: added a parallel `leaderAddr: string | null` (RaftNode) carrying an explicit URL,
  sourced from a new `advertisedUrl` config field (`ADVERTISED_URL` env, default
  `http://${replicaId}:${port}` — already matches how peers reference each other under
  docker-compose, so no compose changes were needed). `AppendEntriesArgs`/`HeartbeatArgs` gained
  an optional `leaderAddr` field the leader stamps on every RPC; followers copy it onto
  `leaderAddr` next to the existing `leaderId`. `handleClientWrite`'s not-leader reply,
  `readBoardState`'s not-leader/unconfirmed reply, and `requestCatchUp`'s target selection all
  switched from `leaderId`/`includes()` to `leaderAddr` directly. `leaderId` (the name) is kept
  as-is for `/status`, logs, and the frontend cluster dashboard — it's a display value, not a
  routing key, and changing that surface wasn't in scope.
- Why: an explicit address is correct by construction; a name is not enough information to
  route on without a lookup that can be wrong.
- Alternatives considered: keep name-only and require peer URLs to be exact-match on the name
  (rejected — still fragile if a deploy renames a host without updating one side); resolve via
  DNS/service-discovery (rejected — free-tier/docker-compose topology doesn't need it, adds a
  dependency for no benefit at this scale).
- Tradeoffs / risks: two leader-identity fields (`leaderId` name, `leaderAddr` URL) now must be
  kept in sync at every call site that sets one — a future change that adds a new leader-setting
  path (e.g. a new RPC type) must remember to set both. `InstallSnapshotArgs` was **not** given a
  `leaderAddr` field (scoped out — that path only fires for a far-behind follower, which will
  also be receiving heartbeats/AppendEntries that carry it moments later); noted here so it's
  not mistaken for an oversight.

### D13 — ReadIndex over leader lease for correct reads; fresh-leader gap documented, not fixed
- Date: 2026-07-19
- Context: `GET /board-state` answered from local state unconditionally. A leader isolated on
  the minority side of a partition still believes it's leader (no RPC has told it otherwise)
  and would serve a stale-authoritative view while the majority side has already elected a new
  leader and moved on — backlog item #3 (HIGH) from the L0 audit.
- Decision: implemented **ReadIndex** (Raft §6.4), not a leader lease. `RaftNode.readBoardState`
  records the current `commitIndex`, then calls a new `confirmLeadership()` which sends the
  already-existing `/heartbeat` RPC to every peer and requires a majority of acks (self + peer
  acks, same term) before answering; any higher-term reply steps the node down
  (`becomeFollower`) and the read is refused. Only on confirmation does it return
  `getStrokes(boardId)`. `rpcHandlers.ts`'s `GET /board-state` returns **421 Misdirected
  Request** + `{ leaderHint }` on refusal (not-leader or unconfirmed) so the gateway can tell
  "not authoritative" apart from "confirmed empty board" (200, `strokes: []`). Gateway
  `remoteRaftClient.getStrokes` follows a 421's `leaderHint` (an explicit URL — see D14) one hop
  before falling through to the next peer.
- Why ReadIndex over lease: no clock-synchronization/bounded-drift assumption between nodes —
  correctness rests only on the same majority-RPC-round argument used everywhere else in this
  Raft implementation, which is what makes it defensible without hedging in an interview. A
  lease would shave the RPC round-trip off every read but requires trusting each node's clock
  drift stays inside the lease window, which this project doesn't want to assume or benchmark.
- **Known bound, not fixed here:** a freshly-elected leader's `commitIndex` reflects only
  entries committed under the current-term commit rule (§5.4.2) — until it commits its first
  current-term entry, `readBoardState` can under-report the last few strokes from before the
  election. This is never *wrong* data and never a stale-from-a-superseded-leader read (the
  property this layer guarantees); it's a narrow, self-closing window (closed by the very next
  committed write) rather than a safety violation. Upgrade path if it ever needs closing: have
  `becomeLeader()` append a no-op `LogEntry` so `commitIndex` becomes current-term-accurate
  immediately — not implemented this layer to keep L3 scoped to the two audit defects and avoid
  extending the stroke/apply path for a bound that's already tightly closed in practice.
- Alternatives considered: leader lease (rejected, clock-assumption above); waiting for
  `lastApplied >= readIndex` with a poll loop (unnecessary — `applyCommitted()` already runs
  synchronously on every commit-index advance, so by the time `confirmLeadership()`'s awaited
  heartbeat round resolves, any concurrently-committed entry up to that point has already been
  applied; no separate wait needed).
- Tradeoffs / risks: every `/board-state` read now costs one extra RPC round-trip (a majority
  heartbeat), versus the previous free local read. Given the read path is a join/refresh
  operation (not a hot per-keystroke path — strokes stream over the websocket separately), this
  cost is accepted without a fallback fast-path.

---

### D12 — L2 snapshot & log compaction implementation choices
- Date: 2026-07-18
- Context: L1 made the WAL durable but unbounded — a cold restart replays the full log, and a
  follower that fell behind the leader's log start had no way to catch up. Implemented across
  `replica/src/raftLog.ts`, `persistence.ts`, `raftNode.ts`, plus a new InstallSnapshot RPC.
- Decision:
  - **Log becomes offset-addressed.** `RaftLog` gained `lastIncludedIndex`/`lastIncludedTerm`;
    every accessor (`getEntry`, `getLastIndex`, `getEntriesFrom`, `truncateFrom`) is offset by
    it, and callers keep using absolute Raft indices unaware compaction happened. `getTermAt`
    added specifically for the AppendEntries `prevLogTerm` consistency check, which must still
    validate at the snapshot boundary itself (where no individual `LogEntry` exists anymore).
  - **Snapshot payload = per-board event list** (not just visible strokes), replayed through the
    existing `applyBoardEvent` — one derivation path for both normal log replay and snapshot
    restore, so undo/redo state reconstructs correctly instead of needing a second serialization
    format.
  - **Snapshot before compact, always.** `takeSnapshot()` persists `snapshot.json` (atomic
    write, same durability as `state.json`) *before* calling `log.compact()`, so a crash between
    the two loses nothing — the WAL still has what the unused snapshot would have covered.
  - **InstallSnapshot has two entry paths, one apply path.** A leader proactively pushes it in
    `sendHeartbeats`/`syncCommittedEntries`/`handleClientWrite` when a peer's `nextIndex` has
    fallen at or below the log's compaction boundary (the entries it needs no longer exist
    individually). A follower's own `requestCatchUp` (used at cold-start) also pulls it via an
    extended `SyncLogResult.snapshot` field when `fromIndex` predates the leader's boundary —
    without this the boot-time catch-up path would silently apply `undefined` for compacted
    indices (a real bug caught while implementing, not just theoretical). Both paths funnel
    through one shared `applySnapshot()` on `RaftNode`.
  - **Threshold:** `RAFT_TIMING.snapshotThresholdEntries = 500` (config default, matches
    PROJECT_PLAN §3), overridable via `SNAPSHOT_THRESHOLD` env / 6th `RaftNode` ctor param —
    `docker-compose.yml` sets it to `20` for demoability without needing hundreds of strokes to
    exercise compaction; real tuning deferred to L8 benchmarks.
- Why: keeps disk and cold-restart time bounded (the whole point of L2) while reusing L1's
  atomic-write primitive and the existing board-apply function rather than inventing new ones.
- Alternatives considered: snapshotting the flattened `boardStrokes` (visible-only) instead of
  the event list — rejected, it would lose undo/redo history and need a second apply path;
  copy-on-write log structure instead of offset indexing — rejected as unnecessary complexity
  for this log's access patterns (sequential append, rare truncate, rare compact).
- Tradeoffs / risks: `takeSnapshot()` and `applySnapshot()` are synchronous full-state
  serializations — fine at demo/interview scale, would need incremental/streaming snapshots at
  much larger board sizes (out of scope, noted for defense). InstallSnapshot ships the entire
  snapshot in one RPC body (no chunking, unlike the paper's `InstallSnapshot` offset/chunk
  fields) — acceptable given board state size at this project's scale; a defensible simplification
  to name explicitly if asked.
- Discovered while implementing: the leader-side `prevLogTerm` computation (`getEntry(idx).term`)
  broke the moment the leader's *own* log compacted past a peer's `nextIndex`, since `getEntry`
  correctly returns `undefined` past the boundary — silently sending `prevLogTerm: 0` and
  causing `append_entries_mismatch` forever. Fixed by switching all four leader-side call sites
  to `getTermAt`, caught live via the Docker e2e gate run (not just unit tests), which is exactly
  why the gate drives real committed writes past the threshold rather than trusting the design
  on paper.
- Supersedes: none (extends D11).

---

### D11 — L1 persistence implementation choices (finalizes D05)
- Date: 2026-07-18
- Context: D05 committed to a hand-rolled WAL + fsynced `state.json` but left the format,
  fsync mechanics, and `commitIndex` durability open. Implemented in `replica/src/persistence.ts`.
- Decision:
  - **Format:** WAL is append-only **JSONL** (one `LogEntry` per line); state is
    `{currentTerm, votedFor, commitIndex}` in a single small JSON file. Both human-inspectable.
  - **Fsync mechanics:** synchronous Node fs calls (`writeSync`/`fsyncSync`, `appendFileSync`
    pattern) so the RPC reply is provably sent only after the sync call returns — no async
    plumbing threaded through every handler. State writes and WAL truncation-rewrites go
    through an atomic temp-file-then-`renameSync` (+ directory fsync) so a crash mid-write
    never leaves a corrupt `state.json` or a partially-truncated log. Directory fsync is a
    no-op on win32 (NTFS/libuv can't fsync a directory fd) — dev-only gap, real on prod Linux.
  - **Torn WAL tail:** only the *last* line can be a partial write from a crash mid-append; the
    loader parses line-by-line and drops an unparseable final line, throws on any earlier one
    (that would indicate real corruption, not a torn write).
  - **commitIndex is persisted** (a deliberate deviation from the paper's volatile
    `commitIndex`): committed entries are never truncated, so persisted `commitIndex ≤ log
    length` always holds — no safety cost — and it lets a solo/cold restart rebuild the board
    from the log immediately instead of waiting for the leader to re-advance commit.
  - **Wiring:** `Persistence` is dependency-injected into `RaftLog`/`RaftNode` (default
    `MemoryPersistence`, so all pre-L1 tests and call sites are untouched); `index.ts`
    constructs `FilePersistence(DATA_DIR)` only when `DATA_DIR` is set.
- Why: keeps the durability mechanics (write-ahead, fsync-before-reply, atomic replace,
  torn-tail handling) fully hand-rolled and explainable, per D05's rationale.
- Alternatives considered: fsync every N entries / debounced (rejected for L1 — batching is
  the documented L4/L8 tuning knob, not a correctness change); volatile commitIndex per the
  strict paper reading (rejected — no safety gain, worse recovery UX).
- Tradeoffs / risks: fsync-per-write costs latency (accepted, to be measured at L8); directory
  fsync doesn't run on Windows dev machines, only prod Linux — noted with a `ponytail:` comment
  at the call site so it isn't mistaken for an oversight.
- Verified: `tests/replica/persistence.test.ts` (state/WAL roundtrip, atomic rewrite, torn-tail
  drop) and `tests/replica/crashRecovery.test.ts` (process-level crash-recovery identity check;
  no-double-vote-across-restart — fails without this change). Docker gate: hard-killed
  `replica2` mid-cluster, `state.json`/`log.jsonl` verified on the host bind mount, restarted
  container reloaded `currentTerm` (did not reset to 0), caught up the write it missed while
  dead, and served the correct board state.

### D10 — Per-replica instance dirs are gitignored runtime state, not source (L0)
- Date: 2026-07-18
- Context: `replica1..4/` each held only a placeholder `README.md` whose sole purpose was to keep the (otherwise empty) Docker bind-mount source dir tracked in git.
- Decision: Delete the placeholder READMEs and gitignore `replica1..3/`; let `docker compose up` create the bind-mount source dirs on the host.
- Why: These dirs are runtime state (and become the L1 WAL/snapshot `DATA_DIR`), not source. Docker auto-creates a missing bind-mount source, so nothing needs to be committed. Removes doc noise the plan flagged.
- Alternatives considered: Replace each README with a `.gitkeep` (still a committed placeholder — same noise); leave as-is (noise + will be overwritten by L1 data anyway).
- Tradeoffs / risks: A fresh clone has no `replica*/` dirs until first `compose up`; acceptable since Docker creates them.

### D09 — Dependency versions pinned exactly to lockfile-resolved versions (L0)
- Date: 2026-07-18
- Context: CLAUDE.md §4 and the L0 gate require reproducible builds; package.json used caret/tilde ranges that let installs drift.
- Decision: Pin every dependency in all three services to the exact version currently resolved in its `package-lock.json` (e.g. `express ^4.21.0` → `4.22.1`), and keep the committed lockfiles as the primary reproducibility mechanism (`npm ci`).
- Why: Exact pins + committed lockfiles make `npm ci` byte-identical across machines and over time, which benchmarks (L8) depend on. Pinning to the *resolved* version (not the old floor) keeps package.json and lock in sync so `npm ci` doesn't error.
- Alternatives considered: Keep ranges and rely on the lockfile alone (works for `npm ci` but `npm install` can silently bump); pin to the old floor version (would desync from lock → `npm ci` failure).
- Tradeoffs / risks: Security/patch updates now require a deliberate bump; acceptable and arguably desirable for a defensible, reproducible project.

### D08 — One config module per service for all tunables (L0)
- Date: 2026-07-18
- Context: Raft timing (election timeout, heartbeat, skew), RPC timeouts, and retry knobs were scattered as magic numbers across `electionTimer.ts`, `rpcClient.ts`, `remoteRaftClient.ts`, and inline `process.env` reads.
- Decision: Add `config.ts` per service (`replica/src/config.ts`, `gateway/src/config.ts`). Env-derived identity/config is parsed by `parseConfig`/`parseGatewayConfig`; fixed tunables live in exported `RAFT_TIMING` / `GATEWAY_TIMING` const objects that the modules import.
- Why: CLAUDE.md §6 — a single source of truth per service makes tuning and benchmark ablations (L8) trivial and every value defensible in an interview. Keeping timing as consts (not env) avoids threading config through constructors and keeps the existing test seams intact (parseConfig still returns exactly `{id,port,peers}`).
- Alternatives considered: Make every knob env-overridable now (more plumbing + would break the parseConfig deep-equal test — YAGNI until benchmarks need it); leave magic numbers in place (fails §6, hard to tune).
- Tradeoffs / risks: Timing changes still require a code edit + redeploy rather than an env flip; env-overridability can be added in the layer that needs it (L8).

### D07 — Governance layer adapted from docsGPT-Agent CLAUDE.md
- Date: 2026-07-18
- Context: Turning Mini-RAFT from lab demo into a deployed, defensible portfolio project needs a repeatable, resume-oriented build process, not ad-hoc edits.
- Decision: Adopt the same operating contract used in the owner's docsGPT-Agent project — `CLAUDE.md` (how), `PROJECT_PLAN.md` (what, layer-by-layer with acceptance gates), `DECISIONS.md` (why), `PROGRESS.md` (state) — retargeted from RAG to Raft.
- Why: The one-layer-at-a-time gate forces correctness and produces an auditable trail of decisions, which is exactly what "defend it in an interview" requires.
- Alternatives considered: Just fix bugs directly (no trail → weak interview story); a single TODO list (no rationale captured).
- Tradeoffs / risks: More documentation overhead per layer; mitigated because the docs *are* the interview prep.

### D06 — Custom Raft retained over an off-the-shelf library
- Date: 2026-07-18
- Context: Could replace the hand-rolled Raft with etcd/raft, dragonboat, or a JS port.
- Decision: Keep the custom TypeScript Raft implementation.
- Why: The entire portfolio value is being able to explain leader election, log replication, and commit safety from code the owner wrote. A library hides exactly what interviews probe.
- Alternatives considered: etcd/raft (Go, battle-tested) — but it moves the interesting logic out of reach; a JS Raft lib — same problem, less mature.
- Tradeoffs / risks: Not battle-tested; must be honest that it is a learning implementation, and back every safety claim with a test.

### D05 — Persistence via hand-rolled WAL + fsynced state.json (Layer 1)
- Date: 2026-07-18
- Context: The critical correctness gap: `currentTerm`, `votedFor`, and the log are in-memory only and never fsynced before RPC replies, so a restart can cause double-voting and split-brain.
- Decision: Implement durability by hand — append-only WAL for log entries, a small fsynced `state.json` for `{currentTerm, votedFor}`, both flushed **before** the dependent RPC reply; reload + replay on boot.
- Why: Raft durability is the single property this project exists to demonstrate; hand-rolling it makes the mechanics (write-ahead, fsync ordering, replay) explainable in an interview.
- Alternatives considered: SQLite/better-sqlite3 (less code but hides the WAL mechanics); LevelDB/RocksDB (realistic but heavier dep and more opaque).
- Tradeoffs / risks: More code and edge cases (partial writes, torn records) to get right; must test crash recovery explicitly. fsync-per-entry costs latency — batching is a later tuning knob (see L4/L8).

### D04 — Deploy the stateful cluster on Oracle Cloud Always Free
- Date: 2026-07-18
- Context: A Raft cluster needs 3+ nodes with persistent disk; the project must be live on a public URL for free.
- Decision: Target Oracle Cloud Always Free (ARM Ampere, real persistent block volumes) for the 3 replicas + gateway; frontend on Vercel/Cloudflare Pages.
- Why: It is the only genuinely always-free option that provides multiple persistent nodes — the exact requirement a Raft cluster has.
- Alternatives considered: Fly.io (good fit but free allowance is now a tiny pay-as-you-go budget → may bill); Render/Railway/Koyeb free (idle spin-down + no persistent disk → invalid Raft nodes).
- Sizing (2026-07): Always Free A1 allowance is **2 OCPUs / 12 GB RAM total** across all A1 instances (Oracle halved the former 4 OCPU / 24 GB, which is now PAYG-only) + 200 GB block storage. This is ample — the 3 replicas + gateway are lightweight Node processes co-located on one VM; CPU/RAM is not the constraint.
- Tradeoffs / risks: Signup needs a card (not charged on Always Free); ARM images required; capacity for free ARM shapes can be intermittent at provision time — claim the A1 instance opportunistically before L7 rather than assuming it will be available on demand.

### D03 — Move from 4 replicas to 3
- Date: 2026-07-18
- Context: The cluster currently runs 4 replicas.
- Decision: Standardize on 3 replicas (odd quorum).
- Why: A 4-node cluster tolerates the same 1 node failure as a 3-node cluster (majority 3 vs 2) but pays more replication overhead and makes split votes likelier. Odd sizes are the Raft norm.
- Alternatives considered: Keep 4 (no benefit); go to 5 (tolerates 2 failures but heavier — overkill for a free-tier demo).
- Tradeoffs / risks: Tolerates only 1 simultaneous failure; acceptable and clearly stated.

### D02 — Correctness audit result: election restriction & commit rule are already correct
- Date: 2026-07-18
- Context: Assumption going in was that core Raft safety might be broken.
- Decision: Treat the election restriction (`isLogUpToDate`) and current-term-only commit rule (`updateCommitIndex`) as **verified assets**, not work items — study them for interview defense rather than rewriting.
- Why: Reading `replica/src/raftNode.ts` in full shows both are implemented per the Raft paper (§5.4.1 up-to-date vote, §5.4.2 no commit of prior-term entries by count).
- Alternatives considered: Rewriting "to be safe" — rejected; it risks regressing correct code and wastes effort.
- Tradeoffs / risks: Must still add tests that pin these properties so a future refactor can't silently break them.

### D01 — Keep the TypeScript / Node / React stack
- Date: 2026-07-18
- Context: Whether to rewrite in Go (closer to real Raft systems) for the upgrade.
- Decision: Keep TS/Node (replica + gateway) and React (frontend).
- Why: The existing implementation, tests, and CI are all TS; a rewrite spends the whole budget on porting instead of the differentiators (durability, snapshots, deploy, benchmarks). TS is also perfectly adequate to demonstrate every Raft property.
- Alternatives considered: Go rewrite (more "systems" credibility but massive rework and loses the working base).
- Tradeoffs / risks: Node's single-threaded async means care around `await` interleaving in replication (addressed in L4); called out rather than hidden.
