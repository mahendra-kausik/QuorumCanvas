# CLAUDE.md — Operating Contract for Mini-RAFT

> This is the source of truth for **how** to build. The **what** lives in `PROJECT_PLAN.md`.
> Every non-trivial choice is logged in `DECISIONS.md`. Session state lives in `PROGRESS.md`.

---

## 1. What we are building (one paragraph)

**Mini-RAFT** — a deployed, fault-tolerant, real-time collaborative drawing board whose
write path is a **hand-rolled Raft consensus cluster** (leader election, replicated log,
majority commit). A React canvas frontend talks over WebSocket to a Node gateway, which
routes every write through the current Raft leader; a stroke becomes visible only after it
is **committed by a majority** of replicas. The upgrade goal is to move this from a
local lab demo to a **production-grade, publicly deployed system that is defensible under
hard distributed-systems interview questions** — with crash-durable persistence,
snapshotting, correct reads, observability, security, and reproducible benchmarks. It runs
on **free-tier compute only** (Oracle Cloud Always Free for the stateful cluster).

The goal is a resume-defensible **SDE/SWE** project. That means strong engineering
(deployed, observable, correct under failure) **and** the ability to explain every design
choice and every Raft safety property from the actual code in an interview.

---

## 2. PRIME DIRECTIVE — build one layer at a time, then STOP

This is the single most important rule. **Violating it is a failure, even if the code is correct.**

1. Build **exactly one layer** from `PROJECT_PLAN.md` §"Build Layers" at a time.
2. When a layer is done, run its **Acceptance Gate** (the checklist for that layer) and show me the result.
3. Update `DECISIONS.md` (any non-trivial choice made during the layer) and `PROGRESS.md`.
4. **Then STOP and explicitly ask me for approval before starting the next layer.**
   Do not begin the next layer, do not "just scaffold ahead," do not batch two layers together.
5. If a layer turns out to be bigger than expected, split it and stop at the first sub-part.

When you finish a layer, end your message with:
`✅ Layer <N> complete. Gate results above. Shall I proceed to Layer <N+1>? (yes / adjust / stop)`

---

## 3. Decision-logging rule (for resume defense)

I must be able to explain **every non-trivial decision** in an interview. So:

- Whenever you make a choice a reviewer could reasonably question — a library, a data
  structure, a timeout, a batch size, a persistence format, a quorum size, a read strategy,
  a deployment platform, a tradeoff — **append an entry to `DECISIONS.md`** using the
  template at the top of that file.
- Keep each entry short but complete: Context → Decision → Why → Alternatives considered → Tradeoffs/risks.
- If a decision reverses an earlier one, add a new entry that references the old one (don't silently edit history).
- Trivial choices (variable names, obvious formatting) do **not** need entries. When unsure, log it.

---

## 4. Hard constraints (do not violate without asking)

- **Correctness before features.** This is a consensus system; a safety bug is worse than a
  missing feature. Every change to the Raft core must preserve the safety properties in
  `DECISIONS.md` and ship with a test that would fail if the property broke.
- **Free tier only.** No paid cloud resources or paid APIs without explicit approval. The
  stateful cluster targets **Oracle Cloud Always Free**; every new dependency must have a
  free tier. Spin-down free tiers (Render/Railway/Koyeb free web) are **not** valid Raft
  nodes — they lose disk and sleep on idle.
- **Deployable, not localhost.** The end state must run at a public URL: a 3-node Raft
  cluster + gateway on the always-free VM, frontend on Vercel/Cloudflare Pages.
- **Durability is real.** Raft persistent state (`currentTerm`, `votedFor`, log) must be
  fsynced to disk **before** the corresponding RPC reply is sent. No exceptions — this is
  the property the whole project exists to demonstrate.
- **Secrets never in git.** The only secret this project introduces is the gateway
  `AUTH_TOKEN` (Layer 6) — keep it in the platform env/secret store, never committed. The
  existing env vars (ports, peer URLs, `VITE_*`) are non-secret config and are fine in git.
- **Reproducible benchmarks.** Pin dependency versions. Benchmark scripts must produce
  comparable numbers on re-run: fixed cluster size, fixed workload, logged params + machine
  spec written into the results file.

---

## 5. Where things live

| File | Purpose |
|---|---|
| `CLAUDE.md` | This file — how to build (protocol, constraints, conventions). |
| `PROJECT_PLAN.md` | What to build — architecture, stack, build layers with acceptance gates, deployment, metrics. |
| `DECISIONS.md` | Decision log with rationale. Update as you build. |
| `PROGRESS.md` | Running state: what's done, what's next, open questions, how to resume. Update every layer. |
| `README.md` | Rewritten LAST (Layer 9) — the "paper": architecture, tradeoffs, honest caveats, benchmark numbers. |
| `Documentation.md` | Existing deep-dive architecture/protocol notes; keep in sync when the protocol changes. |

At the **start of every session**: read `PROGRESS.md` first to see where we are, then continue.
At the **end of every layer**: update `PROGRESS.md` (done / next / blockers) so the next session resumes cleanly.

---

## 6. Coding conventions

- **Language:** TypeScript throughout (frontend React + Vite; gateway Node `http`/`ws`;
  replica Node + Express). Node 20+. Keep it TS — do not rewrite in another language.
- **Structure:** keep the three services separate (`frontend/`, `gateway/`, `replica/`).
  Within the replica, keep Raft concerns modular: log/persistence, node state machine, RPC
  handlers, timers, transport. No merging into one file.
- **Config over constants:** all tunables (election timeout range, heartbeat interval,
  AppendEntries batch cap, snapshot threshold, RPC timeout, retry backoff) live in one
  config module per service — not scattered magic numbers. This makes tuning and benchmark
  ablations trivial and defensible.
- **Typed + documented:** TS strict mode on; a one-line comment on non-obvious Raft logic
  saying *why* (cite the Raft paper section where relevant), not just *what*.
- **Test the seams:** every layer ships at least one test the Acceptance Gate can run.
  Safety-relevant changes ship a test that fails without the fix (e.g. crash-recovery,
  no-double-vote, no-commit-of-prior-term-entry).
- **Small commits per layer:** one logical commit (or a few) per layer, message referencing
  the layer number, e.g. `L1: durable WAL + fsynced term/vote`.
- **Sole authorship:** commits are authored solely by the repo owner. Do **not** add a
  `Co-Authored-By: Claude` (or any AI) trailer, and do not list Claude as a contributor.
  This is a personal, resume-defensible project — the git history must reflect that.

---

## 7. Interaction style I want from you

- Before writing code for a layer, give me a **2–4 line plan** of what you're about to do
  and any decision headed for `DECISIONS.md`. If a decision is genuinely open, ask rather than guess.
- Prefer boring, well-supported libraries over clever ones. This is a project I must defend, not a playground.
- If something in `PROJECT_PLAN.md` looks wrong, outdated, or infeasible on free tier,
  **flag it and stop** — do not silently work around it.
- Keep me in the loop on anything that approaches a free-tier limit or requires a card/cloud signup.
- When running shell commands, don't dump whole outputs into context — bound them with
  `head`/`tail`/filters to only what's needed.
- **Never claim a Raft property holds without a test or a traced code path that proves it.**
  Evidence before assertions — especially for anything I'll repeat in an interview.
