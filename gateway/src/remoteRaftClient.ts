import type { Stroke } from './types.js';
import type { RaftClient } from './raftClient.js';

const RPC_TIMEOUT = 3000;
const MAX_WRITE_ATTEMPTS = 5;
const WRITE_RETRY_BASE_DELAY = 120;
const WRITE_RETRY_MAX_DELAY = 1200;

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

          const leaderHint = result.leaderHint;
          if (leaderHint) {
            const hintPeer = this.peers.find((p) => p.includes(leaderHint));
            if (hintPeer) {
              this.currentLeader = hintPeer;
              const retry = await this.post<{ success: boolean; leaderHint?: string }>(
                `${hintPeer}/client-write`,
                { stroke },
              );
              if (retry.success) {
                return true;
              }
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
      try {
        const result = await this.get<{ boardId: string; strokes: Stroke[] }>(
          `${peer}/board-state?boardId=${encodeURIComponent(boardId)}`,
        );
        return result.strokes;
      } catch {
        // Peer unreachable, try next
      }
    }

    return [];
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

  private async get<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
