/**
 * Exclusive impersonation lock for the shared relay.
 *
 * Impersonation is state in the user's browser session
 * (/api/impersonation/realm/start ... /api/impersonation/end), not in any MCP
 * process. With one relay shared by many MCP instances, two overlapping
 * sequences would run a call as the other's identity. This lock serialises
 * them:
 *
 *  - One holder at a time, identified by an owner id (one per MCP process).
 *    Re-entrant: the lock is held until every nested acquire has been released.
 *  - Plain requests are "admitted": they run at once when the lock is free or
 *    owned by the caller, otherwise they queue behind the holder.
 *  - Waiters are served strictly FIFO. A request admitted ahead of a queued
 *    acquirer is handed to the relay before that acquirer's impersonation can
 *    start, and `run` is invoked synchronously inside the grant so nothing can
 *    slip in between the decision and the relay's own FIFO queue.
 *  - A hold with no activity for `ttlMs` is treated as abandoned. The lock stays
 *    held by EXPIRY_OWNER while `onExpire` cleans up (the daemon sends
 *    /api/impersonation/end), then the next waiter is served.
 */

/** Owner id used while the expiry cleanup runs; the daemon sends its cleanup request as this owner. */
export const EXPIRY_OWNER = '<expired-hold-cleanup>';

export interface LockHolder {
  owner: string;
  since: number;
  depth: number;
}

export type Admission<T> =
  | { admitted: true; value: T }
  | { admitted: false; holder: LockHolder | null };

export interface ImpersonationLockOptions {
  /** A hold with no activity (acquire, release, touch or admitted request) for this long is abandoned. */
  ttlMs: number;
  /** Cleanup run when a hold expires, before anyone else is served. A rejection means "not done yet": it is retried. */
  onExpire?: (expiredOwner: string) => Promise<void> | void;
  /** Delay before a failed cleanup is retried while the cleanup hold lasts (default 5 s, never more than ttlMs). */
  cleanupRetryMs?: number;
}

interface Waiter {
  kind: 'acquire' | 'admit';
  owner: string;
  grant: () => void;
  giveUp: () => void;
  timer: NodeJS.Timeout;
}

export class ImpersonationLock {
  private state: LockHolder | null = null;
  private readonly waiters: Waiter[] = [];
  private ttlTimer: NodeJS.Timeout | undefined;
  private cleanupRetryTimer: NodeJS.Timeout | undefined;
  private readonly cleanupRetryMs: number;
  private readonly ttlMs: number;
  private readonly onExpire?: (expiredOwner: string) => Promise<void> | void;

  constructor(opts: ImpersonationLockOptions) {
    this.ttlMs = opts.ttlMs;
    this.cleanupRetryMs = Math.min(opts.cleanupRetryMs ?? 5_000, opts.ttlMs);
    this.onExpire = opts.onExpire;
  }

  get holder(): LockHolder | null {
    return this.state ? { ...this.state } : null;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Resolves true once `owner` holds the lock, false if it could not within `waitMs`. */
  acquire(owner: string, waitMs: number): Promise<boolean> {
    if (this.state === null) {
      this.takeHold(owner);
      return Promise.resolve(true);
    }
    if (this.state.owner === owner) {
      this.state.depth++;
      this.armTtl();
      return Promise.resolve(true);
    }
    if (waitMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.enqueue('acquire', owner, waitMs, () => resolve(true), () => resolve(false));
    });
  }

  /** Releases one level of `owner`'s hold. False when `owner` does not hold the lock (e.g. it expired). */
  release(owner: string): boolean {
    if (this.state === null || this.state.owner !== owner) return false;
    this.state.depth--;
    if (this.state.depth > 0) {
      this.armTtl();
      return true;
    }
    this.clearHold();
    this.drain();
    return true;
  }

  /** Marks the holder as active, postponing expiry. Ignored for anyone else. */
  touch(owner: string): void {
    if (this.state?.owner === owner) this.armTtl();
  }

  /**
   * Runs `run` as soon as `owner` may use the relay: immediately when the lock is
   * free or owned by `owner`, otherwise after the holder releases. `run` is
   * called synchronously at the moment of admission (it should enqueue the relay
   * request before doing anything asynchronous). Resolves `{admitted:false}` after
   * `waitMs`, naming the holder.
   */
  admit<T>(owner: string, waitMs: number, run: () => T): Promise<Admission<T>> {
    if (this.state === null || this.state.owner === owner) {
      if (this.state) this.armTtl();
      try {
        return Promise.resolve({ admitted: true, value: run() });
      } catch (err) {
        return Promise.reject(err);
      }
    }
    if (waitMs <= 0) return Promise.resolve({ admitted: false, holder: this.holder });
    return new Promise<Admission<T>>((resolve, reject) => {
      this.enqueue(
        'admit',
        owner,
        waitMs,
        () => {
          try {
            resolve({ admitted: true, value: run() });
          } catch (err) {
            reject(err);
          }
        },
        () => resolve({ admitted: false, holder: this.holder })
      );
    });
  }

  /** Settles every waiter as not granted and clears every timer. */
  shutdown(): void {
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = undefined;
    if (this.cleanupRetryTimer) clearTimeout(this.cleanupRetryTimer);
    this.cleanupRetryTimer = undefined;
    this.state = null;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.giveUp();
    }
  }

  private takeHold(owner: string): void {
    this.state = { owner, since: Date.now(), depth: 1 };
    this.armTtl();
  }

  private clearHold(): void {
    if (this.cleanupRetryTimer) clearTimeout(this.cleanupRetryTimer);
    this.cleanupRetryTimer = undefined;
    this.state = null;
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = undefined;
  }

  private armTtl(): void {
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = setTimeout(() => this.expire(), this.ttlMs);
    this.ttlTimer.unref?.();
  }

  private enqueue(
    kind: Waiter['kind'],
    owner: string,
    waitMs: number,
    grant: () => void,
    giveUp: () => void
  ): void {
    const waiter: Waiter = { kind, owner, grant, giveUp, timer: undefined as unknown as NodeJS.Timeout };
    waiter.timer = setTimeout(() => {
      const index = this.waiters.indexOf(waiter);
      if (index === -1) return;
      this.waiters.splice(index, 1);
      giveUp();
    }, waitMs);
    waiter.timer.unref?.();
    this.waiters.push(waiter);
  }

  /**
   * Serves waiters in FIFO order. While the lock is free the head waiter is
   * served (an acquirer becomes the holder and ends the sweep for other owners);
   * while it is held, only the holder's own queued waiters may pass.
   */
  private drain(): void {
    while (this.waiters.length > 0) {
      let index = 0;
      if (this.state !== null) {
        const holderOwner = this.state.owner;
        index = this.waiters.findIndex((w) => w.owner === holderOwner);
        if (index === -1) return;
      }
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      if (waiter.kind === 'acquire') {
        if (this.state === null) this.takeHold(waiter.owner);
        else this.state.depth++;
      }
      waiter.grant();
    }
  }

  private expire(): void {
    this.ttlTimer = undefined;
    const expired = this.state;
    if (expired === null) return;

    // The cleanup itself is stuck: stop making everyone wait for it.
    if (expired.owner === EXPIRY_OWNER) {
      this.clearHold();
      this.drain();
      return;
    }

    const cleanupHold: LockHolder = { owner: EXPIRY_OWNER, since: Date.now(), depth: 1 };
    this.state = cleanupHold;
    this.armTtl(); // bounds how long the cleanup may hold everyone up
    const attempt = (): void => {
      void Promise.resolve()
        .then(() => this.onExpire?.(expired.owner))
        .then(
          () => true,
          () => false
        )
        .then((done) => {
          // Only this expiry's own hold: a late-settling cleanup must not free a newer one.
          if (this.state !== cleanupHold) return;
          if (done) {
            this.clearHold();
            this.drain();
            return;
          }
          // Not done (for example the browser was unreachable): the impersonation may still be live,
          // so keep everyone waiting and try again. The hold's own TTL bounds the wait.
          this.cleanupRetryTimer = setTimeout(attempt, this.cleanupRetryMs);
          this.cleanupRetryTimer.unref?.();
        });
    };
    attempt();
  }
}
