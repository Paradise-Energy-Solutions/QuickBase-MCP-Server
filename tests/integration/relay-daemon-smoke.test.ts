import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { stopDaemon } from '../../src/relay/daemonCli';
import { computeBuildInfo } from '../../src/relay/daemonRuntime';
import { ensureRelayDaemon } from '../../src/relay/launcher';
import { probeRelay } from '../../src/relay/probe';
import { RemoteRelayClient } from '../../src/relay/remote';
import { ensureSecret, relayStatePaths } from '../../src/relay/secret';
import { FakeBookmarklet, TEST_REALM } from '../helpers/daemonHarness';

/**
 * Integration smoke test with REAL processes: the compiled daemon (dist/relay/daemon.js)
 * is spawned detached by the real launcher, MCP-side RemoteRelayClients talk to it over
 * loopback, and it is restarted, raced and idle-exited.
 *
 * Skipped unless QB_RELAY_SMOKE_PORT is set (it needs `npm run build` first). Run it on
 * a scratch port ONLY:
 *
 *     QB_RELAY_SMOKE_PORT=3799 npx jest tests/integration/relay-daemon-smoke.test.ts
 *
 * It uses a temp state directory, refuses port 3737 (the live relay), and cleans up
 * through the authenticated stop command: it never signals or kills any process.
 */

const PORT = Number(process.env.QB_RELAY_SMOKE_PORT ?? 0);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DAEMON_PATH = path.join(PACKAGE_ROOT, 'dist', 'relay', 'daemon.js');
const run = PORT > 0 && fs.existsSync(DAEMON_PATH);
const suite = run ? describe : describe.skip;
const exec = promisify(execFile);

if (PORT === 3737) throw new Error('Refusing to run the smoke test against 3737, the live relay port. Use a scratch port such as 3799.');
if (PORT > 0 && !fs.existsSync(DAEMON_PATH)) console.warn(`Skipping relay smoke test: ${DAEMON_PATH} not found. Run "npm run build" first.`);

suite(`relay daemon smoke test (real processes, scratch port ${PORT})`, () => {
  let stateDir: string;
  const bookmarklets: FakeBookmarklet[] = [];
  const out: string[] = [];

  const launcherOptions = (extraEnv: NodeJS.ProcessEnv = {}) => ({
    port: PORT,
    realm: TEST_REALM,
    stateDir,
    daemonPath: DAEMON_PATH,
    build: computeBuildInfo(path.dirname(DAEMON_PATH), '1.0.0'),
    env: { QB_REALM: TEST_REALM, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA, QB_USER_TOKEN: 'must-not-reach-the-daemon', ...extraEnv },
    readyTimeoutMs: 15_000,
    log: (line: string) => out.push(line),
  });

  const stop = () => stopDaemon({ port: PORT, stateDir, out: (line) => out.push(line) });
  const remote = (ownerId: string) =>
    new RemoteRelayClient({
      port: PORT,
      readSecret: () => ensureSecret(stateDir),
      ensureDaemon: () => ensureRelayDaemon(launcherOptions()),
      ownerId,
    });

  beforeAll(async () => {
    expect((await probeRelay(PORT, 500)).kind).toBe('none'); // the scratch port must be free
  });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-relay-smoke-'));
  });

  afterEach(async () => {
    await Promise.all(bookmarklets.splice(0).map((b) => b.stop()));
    await stop(); // authenticated stop; never a signal
    for (let i = 0; i < 50 && (await probeRelay(PORT, 300)).kind !== 'none'; i++) await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('spawns one detached daemon process, however many starts race, and serves two clients through one bookmarklet', async () => {
    const [a, b] = await Promise.all([ensureRelayDaemon(launcherOptions()), ensureRelayDaemon(launcherOptions())]);
    expect([a.started, b.started]).toEqual([true, true]);

    const probe = await probeRelay(PORT, 2000);
    expect(probe.kind).toBe('daemon');
    if (probe.kind !== 'daemon') return;
    expect(probe.info.pid).not.toBe(process.pid); // a separate OS process
    expect(probe.info.realm).toBe(TEST_REALM);
    expect(fs.existsSync(relayStatePaths(stateDir, PORT).spawnLock)).toBe(false);
    expect(JSON.parse(fs.readFileSync(relayStatePaths(stateDir, PORT).pid, 'utf8')).pid).toBe(probe.info.pid);

    const bookmarklet = new FakeBookmarklet(PORT, (req) => ({ status: 200, data: { echo: req.path } }));
    bookmarklets.push(bookmarklet);
    await bookmarklet.start();
    const one = remote('smoke-client-one');
    const two = remote('smoke-client-two');

    const [ra, rb] = await Promise.all([one.request('/api/one', 'GET'), two.request('/api/two', 'POST', { n: 1 })]);

    expect(ra.data).toEqual({ echo: '/api/one' });
    expect(rb.data).toEqual({ echo: '/api/two' });
  }, 60_000);

  it('a second daemon process started by hand loses the race quietly and exits 0', async () => {
    await ensureRelayDaemon(launcherOptions());
    const before = await probeRelay(PORT, 2000);

    const { stdout, stderr } = await exec(process.execPath, [DAEMON_PATH, 'start', '--port', String(PORT)], {
      env: { QB_REALM: TEST_REALM, QB_RELAY_STATE_DIR: stateDir, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      timeout: 20_000,
    });

    expect(stdout + stderr).toBe('');
    expect(await probeRelay(PORT, 2000)).toEqual(before); // same daemon, same pid
  }, 60_000);

  it('keeps credentials out of the daemon: it never learns QB_USER_TOKEN, and its log never shows the secret', async () => {
    await ensureRelayDaemon(launcherOptions());
    await remote('smoke-client').request('/api/x', 'GET').catch(() => undefined); // not active: 503, still logged

    const log = fs.readFileSync(relayStatePaths(stateDir, PORT).log, 'utf8');
    expect(log).not.toContain('must-not-reach-the-daemon');
    expect(log).not.toContain(ensureSecret(stateDir));
  }, 60_000);

  it('after the daemon is stopped, the next call starts a new one and the already-open bookmarklet re-attaches without a click', async () => {
    await ensureRelayDaemon(launcherOptions());
    const first = await probeRelay(PORT, 2000);
    const bookmarklet = new FakeBookmarklet(PORT, (req) => ({ status: 200, data: { echo: req.path } }));
    bookmarklets.push(bookmarklet);
    await bookmarklet.start();
    const client = remote('smoke-client');
    expect((await client.request('/api/before', 'GET')).data).toEqual({ echo: '/api/before' });

    expect(await stop()).toBe(0); // the daemon goes away (as on idle exit, crash or upgrade)
    for (let i = 0; i < 50 && (await probeRelay(PORT, 300)).kind !== 'none'; i++) await new Promise((r) => setTimeout(r, 100));

    const after = await client.request('/api/after', 'GET'); // starts a new daemon, waits for the tab to re-attach

    expect(after.data).toEqual({ echo: '/api/after' });
    const second = await probeRelay(PORT, 2000);
    expect(second.kind).toBe('daemon');
    if (first.kind === 'daemon' && second.kind === 'daemon') expect(second.info.pid).not.toBe(first.info.pid);
  }, 90_000);

  it('exits by itself after the idle period and cleans up its pid file', async () => {
    await ensureRelayDaemon(launcherOptions({ QB_RELAY_IDLE_MINUTES: '0.03' })); // 1.8 s
    expect((await probeRelay(PORT, 2000)).kind).toBe('daemon');

    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) {
      gone = (await probeRelay(PORT, 300)).kind === 'none';
      if (!gone) await new Promise((r) => setTimeout(r, 100));
    }

    expect(gone).toBe(true);
    expect(fs.existsSync(relayStatePaths(stateDir, PORT).pid)).toBe(false);
  }, 60_000);
});
