import type {
  RpcClient,
  RequestVoteArgs,
  RequestVoteResult,
  AppendEntriesArgs,
  AppendEntriesResult,
  HeartbeatArgs,
  HeartbeatResult,
  SyncLogArgs,
  SyncLogResult,
} from './types.js';

import { RAFT_TIMING } from './config.js';

const RPC_TIMEOUT = RAFT_TIMING.rpcTimeoutMs;

export class HttpRpcClient implements RpcClient {
  private async post<T>(url: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestVote(peer: string, args: RequestVoteArgs): Promise<RequestVoteResult> {
    return this.post<RequestVoteResult>(`${peer}/request-vote`, args);
  }

  async appendEntries(peer: string, args: AppendEntriesArgs): Promise<AppendEntriesResult> {
    return this.post<AppendEntriesResult>(`${peer}/append-entries`, args);
  }

  async sendHeartbeat(peer: string, args: HeartbeatArgs): Promise<HeartbeatResult> {
    return this.post<HeartbeatResult>(`${peer}/heartbeat`, args);
  }

  async syncLog(peer: string, args: SyncLogArgs): Promise<SyncLogResult> {
    return this.post<SyncLogResult>(`${peer}/sync-log`, args);
  }
}
