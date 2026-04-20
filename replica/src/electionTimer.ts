import type { TimerManager } from './types.js';

const ELECTION_TIMEOUT_MIN = 500;
const ELECTION_TIMEOUT_MAX = 800;
const HEARTBEAT_INTERVAL = 150;

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

    // Replica-specific skew reduces repeated split votes when all nodes restart together.
    // A larger skew is intentional for 4-node local clusters where clocks are highly aligned.
    return replicaNumber * 300;
  }

  private randomTimeout(): number {
    const base = ELECTION_TIMEOUT_MIN + Math.floor(Math.random() * (ELECTION_TIMEOUT_MAX - ELECTION_TIMEOUT_MIN + 1));
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
    this.heartbeatTimer = setInterval(callback, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
