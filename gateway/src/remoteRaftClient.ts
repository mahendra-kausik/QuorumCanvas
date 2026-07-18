import type { Stroke } from './types.js';
import type { RaftClient } from './raftClient.js';

import { GATEWAY_TIMING } from './config.js';

const RPC_TIMEOUT = GATEWAY_TIMING.rpcTimeoutMs;
const MAX_WRITE_ATTEMPTS = GATEWAY_TIMING.maxWriteAttempts;
const WRITE_RETRY_BASE_DELAY = GATEWAY_TIMING.writeRetryBaseDelayMs;
const WRITE_RETRY_MAX_DELAY = GATEWAY_TIMING.writeRetryMaxDelayMs;

export class RemoteRaftClient implements RaftClient {
  private currentLeader: string | null = null;

  constructor(private peers: string[]) {}

  async submitStroke(stroke: Stroke): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      // Try known leader first, then all peers.
      const targets = this.currentLeader
        ? [this.currentLeader, ...this.peers.filter((p) => p !== this.currentLeader)]
        : [...this.peers];

      let shouldRetry = false;

      for (const peer of targets) {
        try {
          const result = await this.post<{ success: boolean; leaderHint?: string }>(
            `${peer}/client-write`,
            { stroke },
          );

          if (result.success) {
            this.currentLeader = peer;
            return true;
          }

          shouldRetry = true;

          // leaderHint is now an explicit URL the leader advertises (L3), not a name to
          // substring-match against the peer list.
          const leaderHint = result.leaderHint;
          if (leaderHint) {
            this.currentLeader = leaderHint;
            const retry = await this.post<{ success: boolean; leaderHint?: string }>(
              `${leaderHint}/client-write`,
              { stroke },
            );
            if (retry.success) {
              return true;
            }
          }
        } catch {
          shouldRetry = true;
        }
      }

      if (!shouldRetry || attempt === MAX_WRITE_ATTEMPTS - 1) {
        break;
      }

      const delayMs = Math.min(WRITE_RETRY_BASE_DELAY * Math.pow(2, attempt), WRITE_RETRY_MAX_DELAY);
      await this.delay(delayMs);
    }

    return false;
  }

  async getStrokes(boardId: string): Promise<Stroke[]> {
    // Try leader first, then any available replica
    const targets = this.currentLeader
      ? [this.currentLeader, ...this.peers.filter((p) => p !== this.currentLeader)]
      : [...this.peers];

    for (const peer of targets) {
      const result = await this.tryGetStrokes(peer, boardId);
      if (result) return result.strokes;
    }

    return [];
  }

  // Returns strokes only from a peer that ReadIndex-confirmed it's still leader (status 200).
  // A 421 means "not authoritative" — follow its leaderHint (an explicit URL, L3) one hop
  // rather than treating an unconfirmed read as an empty board.
  private async tryGetStrokes(peer: string, boardId: string, followHint = true): Promise<{ strokes: Stroke[] } | null> {
    try {
      const { status, body } = await this.getRaw<{ boardId: string; strokes: Stroke[]; leaderHint?: string }>(
        `${peer}/board-state?boardId=${encodeURIComponent(boardId)}`,
      );

      if (status === 200) {
        this.currentLeader = peer;
        return { strokes: body.strokes };
      }

      if (status === 421 && body.leaderHint && followHint) {
        this.currentLeader = body.leaderHint;
        return this.tryGetStrokes(body.leaderHint, boardId, false);
      }

      return null;
    } catch {
      return null; // peer unreachable, caller tries next
    }
  }

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Unlike post<T>, does not throw on a non-2xx status — callers that need to distinguish
  // "confirmed" (200) from "not authoritative, here's a hint" (421) read the status themselves.
  private async getRaw<T>(url: string): Promise<{ status: number; body: T }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return { status: res.status, body: (await res.json()) as T };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
