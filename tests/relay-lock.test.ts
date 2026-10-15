import { EXPIRY_OWNER, ImpersonationLock } from '../src/relay/lock';

const TTL_MS = 1000;
const flush = () => jest.advanceTimersByTimeAsync(0);

describe('ImpersonationLock', () => {
  let lock: ImpersonationLock;

  function makeLock(onExpire?: (owner: string) => Promise<void> | void): ImpersonationLock {
    lock = new ImpersonationLock({ ttlMs: TTL_MS, onExpire });
    return lock;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    lock?.shutdown();
    jest.useRealTimers();
  });

  describe('acquire / release', () => {
    it('grants a free lock immediately', async () => {
      makeLock();
      await expect(lock.acquire('A', 0)).resolves.toBe(true);
      expect(lock.holder).toMatchObject({ owner: 'A', depth: 1 });
    });

    it('makes a second owner wait until the holder releases', async () => {
      makeLock();
      await lock.acquire('A', 5000);
      let granted: boolean | undefined;
      const waiting = lock.acquire('B', 5000).then((ok) => (granted = ok));

      await flush();
      expect(granted).toBeUndefined();
      expect(lock.holder?.owner).toBe('A');
      expect(lock.waiting).toBe(1);

      expect(lock.release('A')).toBe(true);
      await expect(waiting).resolves.toBe(true);
      expect(lock.holder?.owner).toBe('B');
      expect(lock.waiting).toBe(0);
    });

    it('grants waiting acquirers in FIFO order', async () => {
      makeLock();
      const order: string[] = [];
      await lock.acquire('A', 5000);
      const waits = ['B', 'C', 'D'].map((owner) => lock.acquire(owner, 5000).then(() => order.push(owner)));

      lock.release('A');
      await flush();
      lock.release('B');
      await flush();
      lock.release('C');
      await Promise.all(waits);

      expect(order).toEqual(['B', 'C', 'D']);
    });

    it('is re-entrant for the holder and frees the lock only when the depth returns to zero', async () => {
      makeLock();
      await lock.acquire('A', 0);
      await expect(lock.acquire('A', 0)).resolves.toBe(true);
      expect(lock.holder?.depth).toBe(2);

      expect(lock.release('A')).toBe(true);
      expect(lock.holder).toMatchObject({ owner: 'A', depth: 1 });
      expect(lock.release('A')).toBe(true);
      expect(lock.holder).toBeNull();
    });

    it('ignores a release from a non-holder and from a free lock', async () => {
      makeLock();
      expect(lock.release('A')).toBe(false);
      await lock.acquire('A', 0);
      expect(lock.release('B')).toBe(false);
      expect(lock.holder?.owner).toBe('A');
    });

    it('does not wait when waitMs is 0', async () => {
      makeLock();
      await lock.acquire('A', 0);
      await expect(lock.acquire('B', 0)).resolves.toBe(false);
      expect(lock.waiting).toBe(0);
    });

    it('stops waiting after waitMs, leaves the queue clean and never grants late', async () => {
      makeLock();
      await lock.acquire('A', 0);
      const waiting = lock.acquire('B', 500); // shorter than the 1000 ms TTL, so A is still the holder

      await jest.advanceTimersByTimeAsync(500);

      await expect(waiting).resolves.toBe(false);
      expect(lock.waiting).toBe(0);
      lock.release('A');
      expect(lock.holder).toBeNull();
    });
  });

  describe('admit (plain requests)', () => {
    it('runs immediately and synchronously when the lock is free', async () => {
      makeLock();
      const run = jest.fn(() => 'value');

      const admission = lock.admit('X', 1000, run);

      expect(run).toHaveBeenCalledTimes(1); // before any await: nothing can overtake it
      await expect(admission).resolves.toEqual({ admitted: true, value: 'value' });
    });

    it('runs immediately for the holder and counts as activity', async () => {
      makeLock();
      await lock.acquire('A', 0);
      await jest.advanceTimersByTimeAsync(800);
      const run = jest.fn(() => 1);

      await lock.admit('A', 1000, run);
      await jest.advanceTimersByTimeAsync(800); // 1600 ms since acquire, 800 ms since the admit

      expect(run).toHaveBeenCalledTimes(1);
      expect(lock.holder?.owner).toBe('A');
    });

    it('makes another owner wait until the holder releases, then runs queued requests in FIFO order', async () => {
      makeLock();
      await lock.acquire('A', 0);
      const order: string[] = [];
      const first = lock.admit('B', 5000, () => order.push('B'));
      const second = lock.admit('C', 5000, () => order.push('C'));

      await flush();
      expect(order).toEqual([]);

      lock.release('A');
      await Promise.all([first, second]);

      expect(order).toEqual(['B', 'C']);
    });

    it('gives up after waitMs and reports who holds the lock', async () => {
      makeLock();
      await lock.acquire('A', 0);
      const run = jest.fn();
      const admission = lock.admit('B', 500, run); // shorter than the 1000 ms TTL, so A is still the holder

      await jest.advanceTimersByTimeAsync(500);

      await expect(admission).resolves.toEqual({
        admitted: false,
        holder: expect.objectContaining({ owner: 'A' }),
      });
      expect(run).not.toHaveBeenCalled();
      expect(lock.waiting).toBe(0);
    });

    it('rejects when run() throws on the fast path', async () => {
      makeLock();
      await expect(
        lock.admit('X', 1000, () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('rejects only the waiter whose run() throws and still serves the ones behind it', async () => {
      makeLock();
      await lock.acquire('A', 0);
      const failing = lock.admit('B', 5000, () => {
        throw new Error('boom');
      });
      const healthy = lock.admit('C', 5000, () => 'ok');
      const failure = expect(failing).rejects.toThrow('boom');

      lock.release('A');

      await failure;
      await expect(healthy).resolves.toEqual({ admitted: true, value: 'ok' });
    });
  });

  describe('queue ordering', () => {
    it('runs requests queued before an acquirer ahead of that acquirer becoming holder', async () => {
      makeLock();
      await lock.acquire('A', 0);
      const holderWhenRequestRan: Array<string | undefined> = [];
      const request = lock.admit('B', 5000, () => holderWhenRequestRan.push(lock.holder?.owner));
      const acquire = lock.acquire('C', 5000);

      lock.release('A');
      await Promise.all([request, acquire]);

      // B's request was released into the relay queue while nobody held the lock,
      // i.e. strictly before C's impersonation could start.
      expect(holderWhenRequestRan).toEqual([undefined]);
      expect(lock.holder?.owner).toBe('C');
    });

    it('keeps requests queued behind an acquirer waiting until that holder releases', async () => {
      makeLock();
      await lock.acquire('A', 0);
      const events: string[] = [];
      const acquire = lock.acquire('C', 5000).then(() => events.push('C holds'));
      const request = lock.admit('B', 5000, () => events.push('request B'));

      lock.release('A');
      await acquire;
      await flush();
      expect(events).toEqual(['C holds']);

      lock.release('C');
      await request;
      expect(events).toEqual(['C holds', 'request B']);
    });

    it("lets the new holder's own queued requests through immediately", async () => {
      makeLock();
      await lock.acquire('A', 0);
      const holderWhenRan: string[] = [];
      const ran = (who: string) => () => holderWhenRan.push(`${who} while holder is ${lock.holder?.owner ?? 'nobody'}`);
      const acquire = lock.acquire('C', 5000);
      const own = lock.admit('C', 5000, ran('C'));
      const other = lock.admit('D', 5000, ran('D'));

      lock.release('A');
      await Promise.all([acquire, own]);
      await flush();

      expect(holderWhenRan).toEqual(['C while holder is C']);
      lock.release('C');
      await other;
      expect(holderWhenRan).toEqual(['C while holder is C', 'D while holder is nobody']);
    });

    it("grants the holder's second queued acquire re-entrantly when its turn comes", async () => {
      makeLock();
      await lock.acquire('A', 0);
      const first = lock.acquire('C', 5000);
      const second = lock.acquire('C', 5000);

      lock.release('A');
      await Promise.all([first, second]);

      expect(lock.holder).toMatchObject({ owner: 'C', depth: 2 });
    });
  });

  describe('TTL expiry of an abandoned hold', () => {
    it('runs the cleanup before granting the next waiter, and lets only the cleanup request through meanwhile', async () => {
      let finishCleanup: () => void = () => {};
      const onExpire = jest.fn(() => new Promise<void>((resolve) => (finishCleanup = resolve)));
      makeLock(onExpire);
      await lock.acquire('A', 0);
      let bGranted = false;
      const waiting = lock.acquire('B', 60_000).then(() => (bGranted = true));

      await jest.advanceTimersByTimeAsync(TTL_MS);

      expect(onExpire).toHaveBeenCalledWith('A');
      expect(lock.holder?.owner).toBe(EXPIRY_OWNER);
      expect(bGranted).toBe(false);
      const cleanupRun = jest.fn(() => 'end-impersonation');
      await expect(lock.admit(EXPIRY_OWNER, 0, cleanupRun)).resolves.toMatchObject({ admitted: true });
      expect(cleanupRun).toHaveBeenCalledTimes(1);

      finishCleanup();
      await expect(waiting).resolves.toBe(true);
      expect(lock.holder?.owner).toBe('B');
    });

    it('does not expire while the holder keeps touching the lock', async () => {
      const onExpire = jest.fn();
      makeLock(onExpire);
      await lock.acquire('A', 0);

      await jest.advanceTimersByTimeAsync(800);
      lock.touch('A');
      await jest.advanceTimersByTimeAsync(800);

      expect(onExpire).not.toHaveBeenCalled();
      expect(lock.holder?.owner).toBe('A');
      await jest.advanceTimersByTimeAsync(300);
      expect(onExpire).toHaveBeenCalledWith('A');
    });

    it('ignores touch() from an owner that does not hold the lock', async () => {
      const onExpire = jest.fn();
      makeLock(onExpire);
      await lock.acquire('A', 0);

      await jest.advanceTimersByTimeAsync(800);
      lock.touch('B');
      await jest.advanceTimersByTimeAsync(300);

      expect(onExpire).toHaveBeenCalledWith('A');
    });

    it('does not expire a lock that was released', async () => {
      const onExpire = jest.fn();
      makeLock(onExpire);
      await lock.acquire('A', 0);
      lock.release('A');

      await jest.advanceTimersByTimeAsync(TTL_MS * 3);

      expect(onExpire).not.toHaveBeenCalled();
    });

    it("treats the expired owner's late release as a no-op and leaves the next holder alone", async () => {
      makeLock(() => {});
      await lock.acquire('A', 0);
      const waiting = lock.acquire('B', 60_000);

      await jest.advanceTimersByTimeAsync(TTL_MS);
      await waiting;

      expect(lock.release('A')).toBe(false);
      expect(lock.holder?.owner).toBe('B');
    });

    it('still frees the lock when the cleanup fails', async () => {
      makeLock(() => Promise.reject(new Error('bookmarklet gone')));
      await lock.acquire('A', 0);
      const waiting = lock.acquire('B', 60_000);

      await jest.advanceTimersByTimeAsync(TTL_MS);

      await expect(waiting).resolves.toBe(true);
    });

    it('frees a stuck cleanup hold after another TTL without running the cleanup again', async () => {
      const onExpire = jest.fn(() => new Promise<void>(() => {})); // never settles
      makeLock(onExpire);
      await lock.acquire('A', 0);
      const waiting = lock.acquire('B', 60_000);

      await jest.advanceTimersByTimeAsync(TTL_MS);
      expect(lock.holder?.owner).toBe(EXPIRY_OWNER);
      await jest.advanceTimersByTimeAsync(TTL_MS);

      await expect(waiting).resolves.toBe(true);
      expect(onExpire).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown', () => {
    it('settles every waiter as not granted and clears all timers', async () => {
      makeLock();
      await lock.acquire('A', 0);
      const acquire = lock.acquire('B', 60_000);
      const admit = lock.admit('C', 60_000, () => 'never');

      lock.shutdown();

      await expect(acquire).resolves.toBe(false);
      await expect(admit).resolves.toMatchObject({ admitted: false });
      expect(lock.holder).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
