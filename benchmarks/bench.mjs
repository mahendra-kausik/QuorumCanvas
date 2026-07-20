#!/usr/bin/env node
// Zero-dependency load/failover harness for Mini-RAFT (L8).
// Usage:
//   node benchmarks/bench.mjs load [--writes=2000] [--concurrency=16] [--ports=3001,3002,3003] [--board=bench-board]
//   node benchmarks/bench.mjs failover [--ports=3001,3002,3003] [--compose-file=docker-compose.yml]
//   node benchmarks/bench.mjs --selftest
//
// Measures directly against a replica's /client-write (not the gateway) — that endpoint has no
// auth (L6 auth is gateway-only) and returns success only after majority commit, so timing it
// is exactly §7's "client submit -> majority commit" latency, with no WS/tunnel noise.
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return flags;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function machineSpec() {
  const c = cpus();
  return {
    cpuModel: c[0]?.model ?? 'unknown',
    cores: c.length,
    totalMemGB: +(totalmem() / 1024 ** 3).toFixed(1),
    nodeVersion: process.version,
    os: `${platform()} ${release()}`,
  };
}

async function getStatus(port) {
  try {
    const res = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function findLeader(ports, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const port of ports) {
      const status = await getStatus(port);
      if (status?.state === 'leader') return { replicaId: status.replicaId, port };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No leader found among ports ${ports.join(',')} within ${timeoutMs}ms`);
}

function makeStroke(boardId, seq) {
  return {
    id: `bench-${seq}-${Date.now()}`,
    boardId,
    userId: 'bench-user',
    color: '#00ff00',
    width: 3,
    points: [[0, 0], [10, 10], [20, 5]],
    timestamp: Date.now(),
  };
}

async function submitWrite(port, boardId, seq) {
  const t0 = performance.now();
  try {
    const res = await fetch(`http://localhost:${port}/client-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stroke: makeStroke(boardId, seq) }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => ({}));
    const ms = performance.now() - t0;
    return { ok: res.ok && body.success === true, ms };
  } catch {
    return { ok: false, ms: performance.now() - t0 };
  }
}

// Simple promise-pool: keeps `concurrency` writes in flight until `total` are issued.
async function runPool(total, concurrency, worker) {
  let next = 0;
  const results = [];
  async function spawn() {
    while (next < total) {
      const seq = next++;
      results.push(await worker(seq));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, spawn));
  return results;
}

function writeResultsFile(name, params, spec, body) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(RESULTS_DIR, `${stamp}-${name}.md`);
  const lines = [
    `# Mini-RAFT benchmark: ${name}`,
    ``,
    `Run at: ${new Date().toISOString()}`,
    ``,
    `## Params`,
    '```json',
    JSON.stringify(params, null, 2),
    '```',
    ``,
    `## Machine spec`,
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
    ``,
    `## Results`,
    body,
    ``,
  ];
  appendFileSync(path, lines.join('\n'));
  return path;
}

async function cmdLoad(flags) {
  const writes = Number(flags.writes ?? 2000);
  const concurrency = Number(flags.concurrency ?? 16);
  const ports = String(flags.ports ?? '3001,3002,3003').split(',').map((s) => s.trim());
  const board = String(flags.board ?? 'bench-board');

  console.log(`Finding leader among ports ${ports.join(',')}...`);
  const leader = await findLeader(ports);
  console.log(`Leader: ${leader.replicaId} (port ${leader.port})`);
  console.log(`Firing ${writes} writes at concurrency ${concurrency}...`);

  const t0 = performance.now();
  const results = await runPool(writes, concurrency, (seq) => submitWrite(leader.port, board, seq));
  const elapsedS = (performance.now() - t0) / 1000;

  const okLatencies = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const failed = results.length - okLatencies.length;
  const throughput = okLatencies.length / elapsedS;
  const stats = {
    committed: okLatencies.length,
    failed,
    elapsedS: +elapsedS.toFixed(3),
    throughputPerSec: +throughput.toFixed(2),
    latencyMs: {
      min: +percentile(okLatencies, 0).toFixed(2),
      p50: +percentile(okLatencies, 50).toFixed(2),
      p99: +percentile(okLatencies, 99).toFixed(2),
      max: +percentile(okLatencies, 100).toFixed(2),
      mean: +(okLatencies.reduce((a, b) => a + b, 0) / (okLatencies.length || 1)).toFixed(2),
    },
  };

  console.log(JSON.stringify(stats, null, 2));
  const path = writeResultsFile('load', { writes, concurrency, ports, board }, machineSpec(), '```json\n' + JSON.stringify(stats, null, 2) + '\n```');
  console.log(`Results written to ${path}`);
}

async function cmdFailover(flags) {
  const ports = String(flags.ports ?? '3001,3002,3003').split(',').map((s) => s.trim());
  const composeFile = String(flags['compose-file'] ?? 'docker-compose.yml');

  console.log('Finding current leader...');
  const leader = await findLeader(ports);
  console.log(`Leader: ${leader.replicaId} (port ${leader.port}) -- stopping it`);

  const t0 = performance.now();
  execSync(`docker compose -f ${composeFile} stop ${leader.replicaId}`, { stdio: 'inherit' });

  console.log('Waiting for a new leader to be elected and confirm a committed write...');
  let newLeader;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      newLeader = await findLeader(ports.filter((p) => p !== String(leader.port)), 3000);
      if (newLeader.replicaId !== leader.replicaId) {
        const write = await submitWrite(newLeader.port, 'bench-failover', 0);
        if (write.ok) break;
      }
      newLeader = undefined;
    } catch {
      // keep polling
    }
  }
  const failoverMs = performance.now() - t0;

  console.log(`Restarting ${leader.replicaId} to leave the cluster whole...`);
  execSync(`docker compose -f ${composeFile} start ${leader.replicaId}`, { stdio: 'inherit' });

  if (!newLeader) {
    console.error('FAILED: no new leader committed a write within 30s');
    process.exitCode = 1;
    return;
  }

  const stats = {
    oldLeader: leader.replicaId,
    newLeader: newLeader.replicaId,
    failoverMs: +failoverMs.toFixed(1),
  };
  console.log(JSON.stringify(stats, null, 2));
  const path = writeResultsFile('failover', { ports, composeFile }, machineSpec(), '```json\n' + JSON.stringify(stats, null, 2) + '\n```');
  console.log(`Results written to ${path}`);
}

function selftest() {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  console.assert(percentile(arr, 0) === 1, 'p0 should be min');
  console.assert(percentile(arr, 100) === 10, 'p100 should be max');
  console.assert(percentile(arr, 50) === 5, `p50 should be 5, got ${percentile(arr, 50)}`);
  console.assert(percentile([], 50) !== percentile([], 50) /* NaN */, 'empty array -> NaN');
  console.log('selftest OK');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest.length ? rest : process.argv.slice(2));

  if (cmd === '--selftest' || flags.selftest) {
    selftest();
    return;
  }
  if (cmd === 'load' || !cmd) {
    await cmdLoad(flags);
  } else if (cmd === 'failover') {
    await cmdFailover(flags);
  } else {
    console.error(`Unknown command: ${cmd}. Use "load", "failover", or "--selftest".`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
