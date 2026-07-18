import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from './types.js';

// Durable Raft state: {currentTerm, votedFor, commitIndex} in state.json, and the log as an
// append-only WAL (one JSON LogEntry per line). Both are fsynced before the RPC reply that
// depends on them (CLAUDE.md §4) — see raftNode.ts persistState() and raftLog.ts append().
//
// commitIndex is deliberately persisted alongside term/vote (a documented deviation from the
// paper's volatile commitIndex, DECISIONS D05): committed entries are never truncated, so a
// persisted commitIndex is always <= log length, and it lets a solo/cold restart rebuild the
// board immediately instead of waiting on the leader to re-advance it.
export interface PersistedState {
  currentTerm: number;
  votedFor: string | null;
  commitIndex: number;
}

export interface Persistence {
  loadState(): PersistedState;
  saveState(state: PersistedState): void;
  loadLog(): LogEntry[];
  appendLog(entry: LogEntry): void;
  rewriteLog(entries: LogEntry[]): void;
}

// Default when no DATA_DIR is configured (e.g. unit tests) — behaves like today's in-memory node.
export class MemoryPersistence implements Persistence {
  loadState(): PersistedState {
    return { currentTerm: 0, votedFor: null, commitIndex: 0 };
  }
  saveState(): void {}
  loadLog(): LogEntry[] {
    return [];
  }
  appendLog(): void {}
  rewriteLog(): void {}
}

// fsync the containing directory too, so the file's directory-entry survives a crash
// (POSIX requires this for the rename/create itself to be durable, not just its content).
// ponytail: no-op on win32 — NTFS/libuv can't open a directory for fsync (EPERM), and prod
// (Oracle Cloud Linux, per CLAUDE.md §4) has the real guarantee; Windows is dev-only here.
function fsyncDir(filePath: string): void {
  if (process.platform === 'win32') return;
  const dirFd = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

// Atomic replace: write to a temp file, fsync it, rename over the target, fsync the dir.
// rename() overwrites the destination atomically on both POSIX and Windows/libuv.
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  fsyncDir(filePath);
}

export class FilePersistence implements Persistence {
  private readonly statePath: string;
  private readonly logPath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.statePath = path.join(dataDir, 'state.json');
    this.logPath = path.join(dataDir, 'log.jsonl');
  }

  loadState(): PersistedState {
    if (!fs.existsSync(this.statePath)) {
      return { currentTerm: 0, votedFor: null, commitIndex: 0 };
    }
    const raw = fs.readFileSync(this.statePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    return { currentTerm: parsed.currentTerm, votedFor: parsed.votedFor, commitIndex: parsed.commitIndex ?? 0 };
  }

  saveState(state: PersistedState): void {
    atomicWrite(this.statePath, JSON.stringify(state));
  }

  loadLog(): LogEntry[] {
    if (!fs.existsSync(this.logPath)) return [];
    const raw = fs.readFileSync(this.logPath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    const entries: LogEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]) as LogEntry);
      } catch {
        // Only the last line can be a torn write (crash mid-append). Drop it, keep the rest.
        if (i !== lines.length - 1) throw new Error(`corrupt WAL line ${i} in ${this.logPath}`);
      }
    }
    return entries;
  }

  appendLog(entry: LogEntry): void {
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDir(this.logPath);
  }

  // Full rewrite on the (rare) truncate-on-conflict path — atomic so a crash mid-rewrite
  // never leaves a partially-truncated WAL.
  rewriteLog(entries: LogEntry[]): void {
    const data = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    atomicWrite(this.logPath, data);
  }
}
