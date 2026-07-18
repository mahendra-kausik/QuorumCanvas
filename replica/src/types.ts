// --- Stroke type (matches frontend/gateway) ---

export interface Stroke {
  id: string;
  boardId: string;
  userId: string;
  color: string;
  width: number;
  points: [number, number][];
  timestamp: number;
  action?: 'stroke' | 'undo_stroke' | 'redo_stroke';
  targetStrokeId?: string;
}

// --- RAFT node state ---

export enum NodeState {
  Follower = 'follower',
  Candidate = 'candidate',
  Leader = 'leader',
}

// --- Log entry ---

export interface LogEntry {
  index: number;
  term: number;
  stroke: Stroke;
}

// --- RPC: RequestVote ---

export interface RequestVoteArgs {
  term: number;
  candidateId: string;
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface RequestVoteResult {
  term: number;
  voteGranted: boolean;
  responderId: string;
}

// --- RPC: AppendEntries ---

export interface AppendEntriesArgs {
  term: number;
  leaderId: string;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry[];
  leaderCommit: number;
}

export interface AppendEntriesResult {
  term: number;
  success: boolean;
  responderId: string;
  currentLogLength: number;
}

// --- RPC: Heartbeat ---

export interface HeartbeatArgs {
  term: number;
  leaderId: string;
  leaderCommit: number;
}

export interface HeartbeatResult {
  term: number;
  success: boolean;
  responderId: string;
}

// --- RPC: SyncLog ---

export interface SyncLogArgs {
  fromIndex: number;
  term: number;
  leaderId: string;
}

export interface SyncLogResult {
  term: number;
  entries: LogEntry[];
  commitIndex: number;
  // Present when the requested fromIndex falls before the leader's snapshot boundary — the
  // leader can no longer serve individual entries that far back, so it sends the snapshot
  // itself for the follower to install before it can continue with the returned `entries`.
  snapshot?: Snapshot;
}

// --- Snapshot (L2 log compaction) ---

// Board state up to lastIncludedIndex, so the WAL prefix that produced it can be dropped.
// `boards` is the per-board *event list* (not just visible strokes) — replaying it through
// raftNode.applyBoardEvent deterministically rebuilds undo/redo state too (one apply path).
export interface Snapshot {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  boards: Record<string, Stroke[]>;
}

// --- RPC: InstallSnapshot (L2 — leader → far-behind follower) ---

export interface InstallSnapshotArgs {
  term: number;
  leaderId: string;
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  boards: Record<string, Stroke[]>;
}

export interface InstallSnapshotResult {
  term: number;
  responderId: string;
}

// --- Client write (gateway → leader) ---

export interface ClientWriteArgs {
  stroke: Stroke;
}

export interface ClientWriteResult {
  success: boolean;
  leaderHint?: string;
}

// --- Status / debug ---

export interface ReplicaStatus {
  replicaId: string;
  state: NodeState;
  currentTerm: number;
  leaderId: string | null;
  logLength: number;
  commitIndex: number;
  lastApplied: number;
}

// --- RPC client interface (for dependency injection) ---

export interface RpcClient {
  requestVote(peer: string, args: RequestVoteArgs): Promise<RequestVoteResult>;
  appendEntries(peer: string, args: AppendEntriesArgs): Promise<AppendEntriesResult>;
  sendHeartbeat(peer: string, args: HeartbeatArgs): Promise<HeartbeatResult>;
  syncLog(peer: string, args: SyncLogArgs): Promise<SyncLogResult>;
  installSnapshot(peer: string, args: InstallSnapshotArgs): Promise<InstallSnapshotResult>;
}

// --- Timer interface (for dependency injection) ---

export interface TimerManager {
  startElectionTimer(callback: () => void): void;
  resetElectionTimer(): void;
  stopElectionTimer(): void;
  startHeartbeat(callback: () => void): void;
  stopHeartbeat(): void;
}
