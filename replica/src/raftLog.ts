import type { LogEntry } from './types.js';
import { MemoryPersistence, type Persistence } from './persistence.js';

// After a snapshot compaction, entries[] no longer starts at log index 1 — it starts at
// lastIncludedIndex + 1. Every accessor below is offset by lastIncludedIndex so callers keep
// using absolute Raft log indices (Raft §7) without knowing whether compaction has happened.
export class RaftLog {
  private entries: LogEntry[] = [];
  private lastIncludedIndex = 0;
  private lastIncludedTerm = 0;

  constructor(private readonly persistence: Persistence = new MemoryPersistence()) {
    this.entries = this.persistence.loadLog();
    const snapshot = this.persistence.loadSnapshot();
    if (snapshot) {
      this.lastIncludedIndex = snapshot.lastIncludedIndex;
      this.lastIncludedTerm = snapshot.lastIncludedTerm;
      // WAL entries at/before the snapshot boundary are redundant (already captured in the
      // snapshot); drop them so getEntry/getLength stay consistent with the offset below.
      this.entries = this.entries.filter((e) => e.index > this.lastIncludedIndex);
    }
  }

  getLastIncludedIndex(): number {
    return this.lastIncludedIndex;
  }

  getLastIncludedTerm(): number {
    return this.lastIncludedTerm;
  }

  // Appends in memory, then fsyncs to the WAL before returning — callers (raftNode) only
  // reply to the dependent RPC after this resolves, satisfying CLAUDE.md §4 durability.
  append(entry: LogEntry): void {
    this.entries.push(entry);
    this.persistence.appendLog(entry);
  }

  getEntry(index: number): LogEntry | undefined {
    if (index <= this.lastIncludedIndex) return undefined;
    return this.entries[index - this.lastIncludedIndex - 1];
  }

  // Term at `index`, including the snapshot boundary itself (which has no LogEntry but does
  // have a known term) — used by the AppendEntries prevLogTerm consistency check so it still
  // validates once entries before the boundary have been compacted away.
  getTermAt(index: number): number {
    if (index === this.lastIncludedIndex) return this.lastIncludedTerm;
    return this.getEntry(index)?.term ?? 0;
  }

  getLastIndex(): number {
    return this.lastIncludedIndex + this.entries.length;
  }

  getLastTerm(): number {
    if (this.entries.length === 0) return this.lastIncludedTerm;
    return this.entries[this.entries.length - 1].term;
  }

  getEntriesFrom(startIndex: number): LogEntry[] {
    if (startIndex <= this.lastIncludedIndex) startIndex = this.lastIncludedIndex + 1;
    return this.entries.slice(startIndex - this.lastIncludedIndex - 1);
  }

  truncateFrom(index: number): void {
    if (index <= this.lastIncludedIndex || index > this.getLastIndex()) return;
    this.entries.length = index - this.lastIncludedIndex - 1;
    this.persistence.rewriteLog(this.entries);
  }

  getLength(): number {
    return this.entries.length;
  }

  // Discard entries up to and including uptoIndex, replacing them with a snapshot boundary.
  // Caller (raftNode.takeSnapshot) must have already persisted the snapshot covering these
  // entries before calling this, so a crash mid-compaction never loses committed state.
  compact(uptoIndex: number, term: number): void {
    if (uptoIndex <= this.lastIncludedIndex) return;
    const keepFrom = uptoIndex - this.lastIncludedIndex; // entries[] index to keep from
    this.entries = this.entries.slice(keepFrom);
    this.lastIncludedIndex = uptoIndex;
    this.lastIncludedTerm = term;
    this.persistence.rewriteLog(this.entries);
  }

  // Replace the whole log with a snapshot boundary from InstallSnapshot — the follower's
  // existing entries (if any) are entirely superseded.
  installSnapshot(lastIncludedIndex: number, lastIncludedTerm: number): void {
    this.entries = this.entries.filter((e) => e.index > lastIncludedIndex);
    this.lastIncludedIndex = lastIncludedIndex;
    this.lastIncludedTerm = lastIncludedTerm;
    this.persistence.rewriteLog(this.entries);
  }
}
