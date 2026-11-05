import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonSettings } from '../src/relay/config';
import { computeBuildInfo, createRotatingLogger, startDaemon } from '../src/relay/daemonRuntime';
import type { DaemonHandle } from '../src/relay/daemonRuntime';
import { RelayAlreadyRunningError } from '../src/relay/errors';
import { readSecret } from '../src/relay/secret';
import { FakeBookmarklet, TEST_REALM } from './helpers/daemonHarness';
import { getFreePort, httpReq, httpReqFull } from './helpers/relayHarness';

// The daemon's process runtime: state files, log, idle exit, authenticated stop.
// Everything uses OS-assigned ports and a temp state directory; nothing touches
// the live relay port or the real %LOCALAPPDATA%\quickbase-mcp.

const BUILD = { buildVersion: '1.0.0+test0001', buildTime: '2026-10-15T00:00:00.000Z' };

let stateDir: string;
const daemons: DaemonHandle[] = [];
const bookmarklets: FakeBookmarklet[] = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-relay-test-runtime-'));
});

afterEach(async () => {
  await Promise.all(bookmarklets.splice(0).map((b) => b.stop()));
  await Promise.all(daemons.splice(0).map((d) => d.stop('test cleanup')));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function launch(overrides: Partial<DaemonSettings> = {}, extra: { maxLogBytes?: number } = {}) {
  const port = overrides.port ?? (await getFreePort());
  const settings: DaemonSettings = {
    realm: TEST_REALM,
    port,
    stateDir,
    idleMs: 0,
    lockTtlMs: 60_000,
    lockWaitMs: 250,
    ...overrides,
  };
  const daemon = await startDaemon({ settings, build: BUILD, ...extra });
  daemons.push(daemon);
  return { daemon, port, paths: daemon.paths };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms`);
}

const answers = (port: number) => async () => {
  try {
    return (await httpReq('GET', port, '/relay/info')).statusCode === 200;
  } catch {
    return false;
  }
};

describe('startDaemon', () => {
  it('creates the secret, pid file and log, and identifies this process on /relay/info', async () => {
    const { daemon, port, paths } = await launch();

    const info = (await httpReq('GET', port, '/relay/info')).body as Record<string, unknown>;
    expect(info).toMatchObject({ pid: process.pid, realm: TEST_REALM, protocolVersion: 1, ...BUILD });
    expect(daemon.info.pid).toBe(process.pid);

    expect(readSecret(stateDir)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(fs.readFileSync(paths.pid, 'utf8'))).toMatchObject({
      pid: process.pid,
      port,
      buildVersion: BUILD.buildVersion,
    });
    expect(fs.readFileSync(paths.log, 'utf8')).toMatch(new RegExp(`started.*${port}`, 'i'));
  });

  it('serves authenticated control calls with the secret stored in the state directory', async () => {
    const { port } = await launch();
    const secret = readSecret(stateDir) as string;
    const body = JSON.stringify({ owner: 'owner-a', path: '/api/x', method: 'GET' });

    const right = await httpReqFull('POST', port, '/relay/rpc', body, { 'X-QB-Relay-Secret': secret });
    const wrong = await httpReqFull('POST', port, '/relay/rpc', body, { 'X-QB-Relay-Secret': 'cd'.repeat(32) });

    expect(right.statusCode).toBe(503); // authenticated; no bookmarklet is connected
    expect(wrong.statusCode).toBe(401);
  });

  it('never writes the secret, tokens or request bodies to the log', async () => {
    const { port, paths } = await launch();
    const secret = readSecret(stateDir) as string;
    await httpReqFull('POST', port, '/relay/rpc', JSON.stringify({ owner: 'owner-a', path: '/api/x?q=SENTINEL-QUERY', method: 'POST', body: { n: 'SENTINEL-BODY' } }), {
      'X-QB-Relay-Secret': secret,
    });

    const log = fs.readFileSync(paths.log, 'utf8');
    for (const forbidden of [secret, 'SENTINEL-QUERY', 'SENTINEL-BODY']) expect(log).not.toContain(forbidden);
  });

  it('reuses the existing secret when a second daemon is started on another port', async () => {
    const first = await launch();
    const secretBefore = readSecret(stateDir);
    await launch();
    expect(readSecret(stateDir)).toBe(secretBefore);
    expect(first.paths.secret).toBe(path.join(stateDir, 'relay.secret'));
  });
});

describe('stopping', () => {
  it('stop() closes the server, removes its own pid file and resolves `stopped` with the reason', async () => {
    const { daemon, port, paths } = await launch();

    await daemon.stop('unit test');

    await expect(daemon.stopped).resolves.toBe('unit test');
    await expect(httpReq('GET', port, '/relay/info')).rejects.toBeDefined();
    expect(fs.existsSync(paths.pid)).toBe(false);
    expect(fs.readFileSync(paths.log, 'utf8')).toContain('unit test');
  });

  it('is idempotent and keeps the first reason', async () => {
    const { daemon } = await launch();
    await daemon.stop('first');
    await daemon.stop('second');
    await expect(daemon.stopped).resolves.toBe('first');
  });

  it('stops on an authenticated POST /relay/stop', async () => {
    const { daemon, port, paths } = await launch();
    const secret = readSecret(stateDir) as string;

    const res = await httpReqFull('POST', port, '/relay/stop', '{}', { 'X-QB-Relay-Secret': secret });

    expect(res.statusCode).toBe(200);
    await expect(daemon.stopped).resolves.toBe('stop requested');
    await until(async () => !(await answers(port)()));
    expect(fs.existsSync(paths.pid)).toBe(false);
  });

  it('ignores an unauthenticated stop request', async () => {
    const { port } = await launch();
    const res = await httpReqFull('POST', port, '/relay/stop', '{}');
    expect(res.statusCode).toBe(401);
    expect(await answers(port)()).toBe(true);
  });

  it('leaves a pid file that no longer names this process', async () => {
    const { daemon, paths } = await launch();
    fs.writeFileSync(paths.pid, JSON.stringify({ pid: process.pid + 1, port: 1 }));

    await daemon.stop('test');

    expect(JSON.parse(fs.readFileSync(paths.pid, 'utf8')).pid).toBe(process.pid + 1);
  });
});

describe('idle exit', () => {
  it('exits after the idle period when nothing happens, releasing the port and its files', async () => {
    const { daemon, port, paths } = await launch({ idleMs: 250 });

    const reason = await Promise.race([daemon.stopped, new Promise<string>((r) => setTimeout(() => r('TIMED OUT'), 4000))]);

    expect(reason).toMatch(/idle/i);
    expect(await answers(port)()).toBe(false);
    expect(fs.existsSync(paths.pid)).toBe(false);
  });

  it('is postponed by client activity (lock calls reset the clock)', async () => {
    const { daemon, port } = await launch({ idleMs: 400 });
    const secret = readSecret(stateDir) as string;
    const poke = () => httpReqFull('POST', port, '/relay/lock/release', JSON.stringify({ owner: 'owner-a' }), { 'X-QB-Relay-Secret': secret });

    for (let i = 0; i < 5; i++) {
      await poke();
      await new Promise((r) => setTimeout(r, 150)); // 750 ms in total: well past one idle period
    }
    expect(await answers(port)()).toBe(true);

    const reason = await Promise.race([daemon.stopped, new Promise<string>((r) => setTimeout(() => r('TIMED OUT'), 4000))]);
    expect(reason).toMatch(/idle/i); // and exits once the activity stops
  });

  it('does not stay alive because of unauthenticated or probe traffic', async () => {
    const { daemon, port } = await launch({ idleMs: 300 });
    const hammer = setInterval(() => {
      void httpReqFull('GET', port, '/relay/info').catch(() => undefined);
      void httpReqFull('POST', port, '/relay/rpc', '{}').catch(() => undefined);
    }, 40);

    const reason = await Promise.race([daemon.stopped, new Promise<string>((r) => setTimeout(() => r('TIMED OUT'), 4000))]);
    clearInterval(hammer);

    expect(reason).toMatch(/idle/i);
  });

  it('stays up while a bookmarklet is connected', async () => {
    const { port } = await launch({ idleMs: 300 });
    const bookmarklet = new FakeBookmarklet(port);
    bookmarklets.push(bookmarklet);
    await bookmarklet.start();

    await new Promise((r) => setTimeout(r, 900));

    expect(await answers(port)()).toBe(true);
  });

  it('never exits on its own when idleMs is 0', async () => {
    const { port } = await launch({ idleMs: 0 });
    await new Promise((r) => setTimeout(r, 500));
    expect(await answers(port)()).toBe(true);
  });
});

describe('losing the race for the port', () => {
  it('a second daemon on the same port stands down quietly and leaves the first one and its files alone', async () => {
    const first = await launch();
    const pidBefore = fs.readFileSync(first.paths.pid, 'utf8');

    await expect(
      startDaemon({
        settings: { realm: TEST_REALM, port: first.port, stateDir, idleMs: 0, lockTtlMs: 60_000, lockWaitMs: 250 },
        build: BUILD,
      }),
    ).rejects.toBeInstanceOf(RelayAlreadyRunningError);

    expect(await answers(first.port)()).toBe(true);
    expect(fs.readFileSync(first.paths.pid, 'utf8')).toBe(pidBefore);
    expect(fs.existsSync(first.paths.log)).toBe(true);
  });
});

describe('createRotatingLogger', () => {
  let logFile: string;

  beforeEach(() => {
    logFile = path.join(stateDir, 'test.log');
  });

  it('appends timestamped lines', () => {
    const log = createRotatingLogger(logFile, 10_000);
    log('hello world');
    log('second line');

    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z hello world$/);
  });

  it('rotates to <file>.old once the size cap is exceeded, keeping the active file small', () => {
    const log = createRotatingLogger(logFile, 400);
    for (let i = 0; i < 30; i++) log(`line number ${i} padded padded padded`);

    expect(fs.existsSync(`${logFile}.old`)).toBe(true);
    expect(fs.statSync(logFile).size).toBeLessThan(800);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('line number 29');
  });

  it('flattens embedded newlines so one log line cannot forge another', () => {
    const log = createRotatingLogger(logFile, 10_000);
    log('first\n2026-01-01T00:00:00.000Z forged entry');

    expect(fs.readFileSync(logFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('never throws when the log cannot be written', () => {
    fs.mkdirSync(logFile); // a directory where the file should be
    const log = createRotatingLogger(logFile, 10_000);
    expect(() => log('still fine')).not.toThrow();
  });

  it('echoes to stderr when asked (foreground use)', () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = createRotatingLogger(logFile, 10_000, true);

    log('visible');

    expect(write).toHaveBeenCalledWith(expect.stringContaining('visible'));
    write.mockRestore();
  });
});

describe('computeBuildInfo', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(stateDir, 'dist-relay');
    fs.mkdirSync(dir);
  });

  it('combines the package version with a short content hash of the relay build', () => {
    fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'b.js'), 'console.log(2)');

    const info = computeBuildInfo(dir, '1.2.3');

    expect(info.buildVersion).toMatch(/^1\.2\.3\+[0-9a-f]{8}$/);
    expect(computeBuildInfo(dir, '1.2.3')).toEqual(info);
  });

  it('changes when any relay file changes, and ignores non-js files', () => {
    fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1)');
    const before = computeBuildInfo(dir, '1.2.3').buildVersion;

    fs.writeFileSync(path.join(dir, 'a.js.map'), '{}');
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export {}');
    expect(computeBuildInfo(dir, '1.2.3').buildVersion).toBe(before);

    fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(999)');
    expect(computeBuildInfo(dir, '1.2.3').buildVersion).not.toBe(before);
  });

  it('reports the newest modification time as the build time', () => {
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-06-01T12:34:56.000Z');
    fs.writeFileSync(path.join(dir, 'a.js'), 'a');
    fs.writeFileSync(path.join(dir, 'b.js'), 'b');
    fs.utimesSync(path.join(dir, 'a.js'), older, older);
    fs.utimesSync(path.join(dir, 'b.js'), newer, newer);

    expect(computeBuildInfo(dir, '1.2.3').buildTime).toBe(newer.toISOString());
  });

  it('copes with a missing or empty directory', () => {
    expect(computeBuildInfo(path.join(dir, 'nope'), '1.2.3').buildVersion).toBe('1.2.3+00000000');
    expect(computeBuildInfo(dir, '1.2.3').buildVersion).toBe('1.2.3+00000000');
  });
});
