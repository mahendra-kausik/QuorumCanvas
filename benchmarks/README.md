# Mini-RAFT Benchmarks (Layer 8)

`bench.mjs` is a zero-dependency Node script (built-in `fetch` + `node:perf_hooks` only — no
`npm install`, no build step) that measures committed-write throughput, p50/p99 commit latency
and leader-failover time directly against a replica's `/client-write` endpoint. That endpoint has no auth (L6 auth is gateway-only) and
returns `{"success":true}` only after the write is committed by a majority — so timing it is
exactly "client submit → majority commit" latency, with no WebSocket/tunnel overhead in the way.

## Commands

```sh
# throughput + p50/p99 commit latency
node benchmarks/bench.mjs load [--writes=2000] [--concurrency=16] [--ports=3001,3002,3003] [--board=bench-board]

# leader-election / failover time: stops the current leader's container, times until
# a new leader elects and commits a write, then restarts the stopped container.
node benchmarks/bench.mjs failover [--ports=3001,3002,3003] [--compose-file=docker-compose.yml]

# math self-check, no cluster required
node benchmarks/bench.mjs --selftest
```

Each run prints a summary and appends a timestamped Markdown file under `benchmarks/results/`
with the params, machine spec, and results — so a number can always be traced back to what
produced it.

## Reproducibility

Params are fixed by default (`writes=2000`, `concurrency=16`, fixed stroke shape/size) precisely
so a re-run lands in the same ballpark — see the two `*-load.md` files captured back-to-back in
`benchmarks/results/` for the local cluster.

## Partition behavior

Not a percentile, so not in this harness. Already demonstrated (qualitatively, with real
network-level partitioning) by `scripts/test-network-partition.sh` — minority side stops serving
writes, majority side keeps committing, and the healed partition catches up with no data lost.

## Running against the live GCP deployment

The VM never installs the TypeScript toolchain (avoids `npm ci`+`tsc` on the 2GB shape), but
`bench.mjs` needs nothing but a Node runtime and doesn't touch `npm`/TypeScript at all. From the
repo on the VM (`~/mini-raft`, already a git checkout):

```sh
git pull
# one-off portable Node runtime (no apt/system install, deleted after use):
curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz -o /tmp/node.tar.xz
mkdir -p /tmp/node20 && tar -xJf /tmp/node.tar.xz -C /tmp/node20 --strip-components=1

/tmp/node20/bin/node benchmarks/bench.mjs load
/tmp/node20/bin/node benchmarks/bench.mjs failover --compose-file docker-compose.prod.yml

rm -rf /tmp/node20 /tmp/node.tar.xz
```

Prod compose (`docker-compose.prod.yml`) publishes replica ports `3001-3003` on the VM host, so
the default `--ports` flag works unchanged. Copy the resulting `benchmarks/results/*.md` files
back into the local repo and commit them.

**Reminder:** the GCP VM runs on a 90-day free trial. Once benchmarking is done, tear it
down (`gcloud compute instances delete mini-raft --project=mini-raft-prod
--zone=asia-south1-a`) to stop credit burn.
