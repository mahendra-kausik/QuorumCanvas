import type { LogEntry } from './types.js';
import { MemoryPersistence, type Persistence } from './persistence.js';

export class RaftLog {
  private entries: LogEntry[] = [];

  constructor(private readonly persistence: Persistence = new MemoryPersistence()) {
    this.entries = this.persistence.loadLog();
  }

  // Appends in memory, then fsyncs to the WAL before returning — callers (raftNode) only
  // reply to the dependent RPC after this resolves, satisfying CLAUDE.md §4 durability.
  append(entry: LogEntry): void {
    this.entries.push(entry);
    this.persistence.appendLog(entry);
  }

  getEntry(index: number): LogEntry | undefined {
    if (index < 1) return undefined;
    return this.entries[index - 1];
  }

  getLastIndex(): number {
    return this.entries.length;
  }

  getLastTerm(): number {
    if (this.entries.length === 0) return 0;
    return this.entries[this.entries.length - 1].term;
  }

  getEntriesFrom(startIndex: number): LogEntry[] {
    if (startIndex < 1) startIndex = 1;
    return this.entries.slice(startIndex - 1);
  }

  truncateFrom(index: number): void {
    if (index < 1 || index > this.entries.length) return;
    this.entries.length = index - 1;
    this.persistence.rewriteLog(this.entries);
  }

  getLength(): number {
    return this.entries.length;
  }
}
