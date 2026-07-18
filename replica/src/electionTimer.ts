import type { TimerManager } from './types.js';
import { RAFT_TIMING } from './config.js';

const { electionTimeoutMinMs, electionTimeoutMaxMs, heartbeatIntervalMs, electionSkewStepMs } =
  RAFT_TIMING;

interface TimerManagerOptions {
  replicaId?: string;
}

export class DefaultTimerManager implements TimerManager {
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private electionCallback: (() => void) | null = null;
  private readonly electionSkewMs: number;

  constructor(options: TimerManagerOptions = {}) {
    this.electionSkewMs = this.computeElectionSkew(options.replicaId);
  }

  private computeElectionSkew(replicaId?: string): number {
    if (!replicaId) {
      return 0;
    }

    const replicaNumber = Number.parseInt(replicaId.replace(/\D+/g, ''), 10);
    if (Number.isNaN(replicaNumber)) {
      return 0;
    }

    // Replica-specific skew reduces repeated split votes when all nodes restart together
    // with tightly aligned clocks (3-node local cluster).
    return replicaNumber * electionSkewStepMs;
  }

  private randomTimeout(): number {
    const base =
      electionTimeoutMinMs + Math.floor(Math.random() * (electionTimeoutMaxMs - electionTimeoutMinMs + 1));
    return base + this.electionSkewMs;
  }

  startElectionTimer(callback: () => void): void {
    this.electionCallback = callback;
    this.resetElectionTimer();
  }

  resetElectionTimer(): void {
    if (this.electionTimer !== null) {
      clearTimeout(this.electionTimer);
    }
    if (this.electionCallback) {
      const timeout = this.randomTimeout();
      this.electionTimer = setTimeout(() => {
        this.electionCallback?.();
      }, timeout);
    }
  }

  stopElectionTimer(): void {
    if (this.electionTimer !== null) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
  }

  startHeartbeat(callback: () => void): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(callback, heartbeatIntervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
