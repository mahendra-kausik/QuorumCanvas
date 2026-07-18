import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilePersistence } from '../../replica/src/persistence.js';
import type { LogEntry } from '../../replica/src/types.js';

function makeEntry(index: number, term = 1): LogEntry {
  return {
    index,
    term,
    stroke: { id: `s${index}`, boardId: 'b1', userId: 'u1', color: '#000', width: 1, points: [[0, 0]], timestamp: index },
  };
}

describe('FilePersistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-persist-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips state.json', () => {
    const p = new FilePersistence(dir);
    p.saveState({ currentTerm: 4, votedFor: 'node-2', commitIndex: 3 });

    const reloaded = new FilePersistence(dir);
    expect(reloaded.loadState()).toEqual({ currentTerm: 4, votedFor: 'node-2', commitIndex: 3 });
  });

  it('defaults to term 0 / null vote / commitIndex 0 when no state file exists', () => {
    const p = new FilePersistence(dir);
    expect(p.loadState()).toEqual({ currentTerm: 0, votedFor: null, commitIndex: 0 });
  });

  it('round-trips the WAL across instances', () => {
    const p = new FilePersistence(dir);
    p.appendLog(makeEntry(1));
    p.appendLog(makeEntry(2));

    const reloaded = new FilePersistence(dir);
    expect(reloaded.loadLog()).toEqual([makeEntry(1), makeEntry(2)]);
  });

  it('rewriteLog atomically replaces the WAL (truncate-on-conflict path)', () => {
    const p = new FilePersistence(dir);
    p.appendLog(makeEntry(1));
    p.appendLog(makeEntry(2));
    p.appendLog(makeEntry(3));

    p.rewriteLog([makeEntry(1)]);

    const reloaded = new FilePersistence(dir);
    expect(reloaded.loadLog()).toEqual([makeEntry(1)]);
  });

  it('drops a torn (partial) final WAL line but keeps everything before it', () => {
    const p = new FilePersistence(dir);
    p.appendLog(makeEntry(1));
    p.appendLog(makeEntry(2));

    // Simulate a crash mid-write: truncate the log file partway through the last line.
    const logPath = path.join(dir, 'log.jsonl');
    const raw = fs.readFileSync(logPath, 'utf8');
    fs.writeFileSync(logPath, raw.slice(0, raw.length - 5));

    const reloaded = new FilePersistence(dir);
    expect(reloaded.loadLog()).toEqual([makeEntry(1)]);
  });
});
