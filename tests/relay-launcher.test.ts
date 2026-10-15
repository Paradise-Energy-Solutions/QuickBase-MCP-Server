import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ensureRelayDaemon } from '../src/relay/launcher';
import type { LauncherOptions, SpawnFn } from '../src/relay/launcher';
import type { RelayInfo } from '../src/relay/types';
import { ensureSecret, relayStatePaths } from '../src/relay/secret';
import { TEST_REALM, TestDaemon, startTestDaemon } from './helpers/daemonHarness';
import { getFreePort } from './helpers/relayHarness';

// ensureRelayDaemon decides what to do about whatever is on the relay port, and
// spawns the daemon detached when nothing is. Spawning is faked here (the fake
// brings an in-process daemon up on a scratch port); the real spawn is exercised
// by tests/integration/relay-daemon-smoke.test.ts. Nothing touches port 3737.

const MINE = { buildVersion: '1.0.0+mine0001', buildTime: '2026-10-15T12:00:00.000Z' };
const OLDER_BUILD = { buildVersion: '1.0.0+old00001', buildTime: '2026-10-14T12:00:00.000Z' };
const SAME_BUILD = { ...MINE };

let stateDir: string;
let secret: string;
const daemons: TestDaemon[] = [];
const occupants: http.Server[] = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-relay-test-launcher-'));
  secret = ensureSecret(stateDir);
});

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  await Promise.all(
    occupants.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function runningDaemon(port: number, info: Partial<RelayInfo> = {}): Promise<TestDaemon> {
  const d = await startTestDaemon({ port, secret, closeOnStop: true, info });
  daemons.push(d);
  return d;
}

interface FakeSpawn {
  spawn: jest.Mock;
  calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>;
  child: { unref: jest.Mock; on: jest.Mock; pid: number };
}

/** A spawn that records its arguments and, when told to, brings a daemon up as the real child would. */
function fakeSpawn(onSpawn: () => void | Promise<void> = () => {}): FakeSpawn {
  const calls: FakeSpawn['calls'] = [];
  const child = { unref: jest.fn(), on: jest.fn(), pid: 4321 };
  const spawn = jest.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    void Promise.resolve(onSpawn());
    return child;
  });
  return { spawn, calls, child };
}

function options(port: number, over: Partial<LauncherOptions> = {}): LauncherOptions {
  return {
    port,
    realm: TEST_REALM,
    stateDir,
    daemonPath: path.join(stateDir, 'dist', 'relay', 'daemon.js'),
    build: MINE,
    env: { QB_REALM: TEST_REALM, PATH: '/usr/bin' },
    readyTimeoutMs: 3000,
    log: () => {},
    ...over,
  };
}

async function occupy(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, port?: number): Promise<{ port: number; requests: string[] }> {
  const chosen = port ?? (await getFreePort());
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(chosen, '127.0.0.1', () => resolve()));
  occupants.push(server);
  return { port: chosen, requests };
}

/** An old-build in-process relay: no /relay/info, status { active, realmUser }, and a shutdown that really closes it. */
function legacyRelay(active: boolean): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    if (req.method === 'GET' && req.url === '/relay/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active, realmUser: active ? 'jane.quickbase.com' : null }));
    } else if (req.method === 'POST' && req.url === '/relay/shutdown') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      setImmediate(() => {
        const self = occupants[occupants.length - 1]; // the occupant that was started for this test
        self.closeAllConnections?.();
        self.close();
      });
    } else {
      res.writeHead(404).end();
    }
  };
}

describe('nothing is running', () => {
  it('spawns the daemon detached and waits until it answers', async () => {
    const port = await getFreePort();
    const fake = fakeSpawn(async () => void (await runningDaemon(port, SAME_BUILD)));

    const outcome = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn }));

    expect(outcome).toEqual({ started: true });
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual([path.join(stateDir, 'dist', 'relay', 'daemon.js'), 'start']);
    expect(call.options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(fake.child.unref).toHaveBeenCalledTimes(1);
  });

  it('hands the daemon only relay settings and OS essentials, never credentials', async () => {
    const port = await getFreePort();
    const fake = fakeSpawn(async () => void (await runningDaemon(port, SAME_BUILD)));

    await ensureRelayDaemon(
      options(port, {
        spawn: fake.spawn as unknown as SpawnFn,
        env: {
          QB_REALM: TEST_REALM,
          QB_USER_TOKEN: 'super-secret-token',
          QB_APP_abc_NAME: 'My App',
          QB_RELAY_IDLE_MINUTES: '5',
          PIPELINES_PAGE_TOKEN: 'csrf',
          ANTHROPIC_API_KEY: 'sk-ant-xxx',
          PATH: '/usr/bin',
        },
      }),
    );

    const env = fake.calls[0].options.env as Record<string, string>;
    expect(env).toEqual({
      QB_REALM: TEST_REALM,
      QB_RELAY_PORT: String(port),
      QB_RELAY_STATE_DIR: stateDir,
      QB_RELAY_IDLE_MINUTES: '5',
      PATH: '/usr/bin',
    });
    expect(JSON.stringify(fake.calls[0])).not.toMatch(/super-secret-token|sk-ant|csrf/);
  });

  it('rejects with the log location when the daemon does not become ready in time, and releases its spawn lock', async () => {
    const port = await getFreePort();
    const fake = fakeSpawn(); // the child never starts serving
    const paths = relayStatePaths(stateDir, port);

    const error = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn, readyTimeoutMs: 400 })).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/did not become ready/i);
    expect((error as Error).message).toContain(paths.log);
    expect(fs.existsSync(paths.spawnLock)).toBe(false);
  });

  it('reports a spawn failure', async () => {
    const port = await getFreePort();
    const child = { unref: jest.fn(), on: jest.fn((event: string, cb: (err: Error) => void) => event === 'error' && setImmediate(() => cb(new Error('spawn ENOENT: node not found')))) };
    const spawn = jest.fn(() => child);

    await expect(ensureRelayDaemon(options(port, { spawn: spawn as unknown as SpawnFn, readyTimeoutMs: 1500 }))).rejects.toThrow(/ENOENT/);
  });

  it('spawns exactly one daemon when two starts race (spawn lock), and both callers see it', async () => {
    const port = await getFreePort();
    const fake = fakeSpawn(async () => {
      await new Promise((r) => setTimeout(r, 150)); // slow start: the second caller arrives meanwhile
      await runningDaemon(port, SAME_BUILD);
    });
    const opts = options(port, { spawn: fake.spawn as unknown as SpawnFn });

    const [a, b] = await Promise.all([ensureRelayDaemon(opts), ensureRelayDaemon(opts)]);

    expect(fake.spawn).toHaveBeenCalledTimes(1);
    expect([a.started, b.started]).toEqual([true, true]);
    expect(fs.existsSync(relayStatePaths(stateDir, port).spawnLock)).toBe(false);
  });

  it('removes a stale spawn lock left by a crashed starter and spawns', async () => {
    const port = await getFreePort();
    const paths = relayStatePaths(stateDir, port);
    fs.writeFileSync(paths.spawnLock, 'dead process');
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.spawnLock, longAgo, longAgo);
    const fake = fakeSpawn(async () => void (await runningDaemon(port, SAME_BUILD)));

    await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn, spawnLockStaleMs: 15_000 }));

    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });

  it('waits for a daemon that another process is starting instead of spawning a second one (fresh spawn lock)', async () => {
    const port = await getFreePort();
    fs.writeFileSync(relayStatePaths(stateDir, port).spawnLock, 'another MCP is starting the daemon');
    const fake = fakeSpawn();
    setTimeout(() => void runningDaemon(port, SAME_BUILD), 200);

    const outcome = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn }));

    expect(outcome).toEqual({ started: true });
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});

describe('a daemon is already running', () => {
  it('reuses a compatible daemon of the same build without spawning or stopping anything', async () => {
    const port = await getFreePort();
    const d = await runningDaemon(port, SAME_BUILD);
    const fake = fakeSpawn();

    const outcome = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn }));

    expect(outcome).toEqual({ started: false });
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(d.stopReasons).toEqual([]);
  });

  it('reuses a daemon of the same protocol that is a NEWER build than this MCP', async () => {
    const port = await getFreePort();
    const d = await runningDaemon(port, { buildVersion: '1.0.0+newer001', buildTime: '2026-10-16T00:00:00.000Z' });
    const fake = fakeSpawn();

    await expect(ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn }))).resolves.toEqual({ started: false });
    expect(d.stopReasons).toEqual([]);
  });

  it('does not replace a daemon of the identical build just because its files carry an older timestamp', async () => {
    const port = await getFreePort();
    const d = await runningDaemon(port, { buildVersion: MINE.buildVersion, buildTime: '2026-10-01T00:00:00.000Z' });
    const fake = fakeSpawn();

    await expect(ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn }))).resolves.toEqual({ started: false });
    expect(d.stopReasons).toEqual([]);
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('refuses a daemon for a different QuickBase realm and names it, the port setting and the pid', async () => {
    const port = await getFreePort();
    await runningDaemon(port, { ...SAME_BUILD, realm: 'someone-else.quickbase.com', pid: 5150 });
    const fake = fakeSpawn();

    const error = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn })).catch((e: Error) => e);

    expect((error as Error).message).toContain('someone-else.quickbase.com');
    expect((error as Error).message).toContain('QB_RELAY_PORT');
    expect((error as Error).message).toContain('5150');
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('degrades, naming pid and build, when the daemon speaks a NEWER protocol than this MCP', async () => {
    const port = await getFreePort();
    const d = await runningDaemon(port, { ...SAME_BUILD, protocolVersion: 2, pid: 777, buildVersion: '2.0.0+proto002' });
    const fake = fakeSpawn();

    const error = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn })).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/newer/i);
    expect((error as Error).message).toContain('777');
    expect((error as Error).message).toContain('2.0.0+proto002');
    expect(d.stopReasons).toEqual([]);
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  describe('an OLDER build than this MCP', () => {
    it('is replaced when it is idle: authenticated stop(ifIdle), then a fresh spawn', async () => {
      const port = await getFreePort();
      const old = await runningDaemon(port, OLDER_BUILD);
      const fake = fakeSpawn(async () => void (await runningDaemon(port, SAME_BUILD)));

      const outcome = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn }));

      expect(outcome).toEqual({ started: true });
      expect(old.stopReasons).toEqual(['stop requested (idle replacement)']);
      expect(fake.spawn).toHaveBeenCalledTimes(1);
    });

    it('is kept (no error) when busy and still protocol-compatible, so nothing in use is interrupted', async () => {
      const port = await getFreePort();
      const old = await runningDaemon(port, OLDER_BUILD);
      old.client.receiveHello('tok', TEST_REALM); // a bookmarklet is connected: not idle
      const fake = fakeSpawn();

      await expect(ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn }))).resolves.toEqual({ started: false });

      expect(old.stopReasons).toEqual([]);
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it('with an OLDER PROTOCOL: replaced when idle', async () => {
      const port = await getFreePort();
      const old = await runningDaemon(port, { ...OLDER_BUILD, protocolVersion: 0 });
      const fake = fakeSpawn(async () => void (await runningDaemon(port, SAME_BUILD)));

      await expect(ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn, build: { ...MINE } }))).resolves.toEqual({ started: true });
      expect(old.stopReasons).toHaveLength(1);
    });

    it('with an OLDER PROTOCOL: degrades with pid, build and a stop hint when busy', async () => {
      const port = await getFreePort();
      const old = await runningDaemon(port, { ...OLDER_BUILD, protocolVersion: 0, pid: 888 });
      old.client.receiveHello('tok', TEST_REALM);
      const fake = fakeSpawn();

      const error = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn })).catch((e: Error) => e);

      expect((error as Error).message).toContain('888');
      expect((error as Error).message).toContain(OLDER_BUILD.buildVersion);
      expect((error as Error).message).toMatch(/older/i);
      expect((error as Error).message).toContain('relay:stop');
      expect(old.stopReasons).toEqual([]);
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it('with an OLDER PROTOCOL: reports a secret mismatch instead of guessing', async () => {
      const port = await getFreePort();
      const old = await startTestDaemon({ port, secret: 'cd'.repeat(32), closeOnStop: true, info: { ...OLDER_BUILD, protocolVersion: 0 } });
      daemons.push(old);

      await expect(ensureRelayDaemon(options(port, { spawn: fakeSpawn().spawn as unknown as SpawnFn }))).rejects.toThrow(/secret/i);
      expect(old.stopReasons).toEqual([]);
    });
  });
});

describe('a legacy in-process relay (old MCP build) holds the port', () => {
  it('replaces an INACTIVE one through the old shutdown request, then spawns the daemon', async () => {
    const { port, requests } = await occupy(legacyRelay(false));
    const fake = fakeSpawn(async () => void (await runningDaemon(port, SAME_BUILD)));

    const outcome = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn }));

    expect(outcome).toEqual({ started: true });
    expect(requests).toContain('POST /relay/shutdown');
    expect(fake.spawn).toHaveBeenCalledTimes(1);
  });

  it('does NOT kill an ACTIVE one by default; explains the one-time migration instead', async () => {
    const { port, requests } = await occupy(legacyRelay(true));
    const fake = fakeSpawn();

    const error = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn })).catch((e: Error) => e);

    expect((error as Error).message).toContain('QB_RELAY_REPLACE_LEGACY');
    expect((error as Error).message).toMatch(/bookmarklet/i);
    expect(requests.some((r) => r.startsWith('POST'))).toBe(false);
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('replaces an ACTIVE one when QB_RELAY_REPLACE_LEGACY is set', async () => {
    const { port, requests } = await occupy(legacyRelay(true));
    const fake = fakeSpawn(async () => void (await runningDaemon(port, SAME_BUILD)));

    const outcome = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn, replaceLegacy: true }));

    expect(outcome).toEqual({ started: true });
    expect(requests).toContain('POST /relay/shutdown');
  });

  it('gives up with a clear message when the legacy relay ignores the shutdown', async () => {
    const { port } = await occupy((req, res) => {
      if (req.url === '/relay/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: false, realmUser: null }));
      } else {
        res.writeHead(403).end(); // refuses to shut down
      }
    });

    await expect(
      ensureRelayDaemon(options(port, { spawn: fakeSpawn().spawn as unknown as SpawnFn, readyTimeoutMs: 600 })),
    ).rejects.toThrow(/still holds port|did not release/i);
  });
});

describe('something that is not a relay holds the port', () => {
  it('names the port and the setting, and sends nothing but GET probes', async () => {
    const { port, requests } = await occupy((_req, res) => res.writeHead(404).end());
    const fake = fakeSpawn();

    const error = await ensureRelayDaemon(options(port, { spawn: fake.spawn as unknown as SpawnFn })).catch((e: Error) => e);

    expect((error as Error).message).toContain(String(port));
    expect((error as Error).message).toContain('QB_RELAY_PORT');
    expect(requests.every((r) => r.startsWith('GET '))).toBe(true);
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});
