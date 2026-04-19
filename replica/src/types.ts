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
}

// --- Timer interface (for dependency injection) ---

export interface TimerManager {
  startElectionTimer(callback: () => void): void;
  resetElectionTimer(): void;
  stopElectionTimer(): void;
  startHeartbeat(callback: () => void): void;
  stopHeartbeat(): void;
}
