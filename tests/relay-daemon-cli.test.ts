import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseDaemonArgs, showStatus, stopDaemon } from '../src/relay/daemonCli';
import { startDaemon } from '../src/relay/daemonRuntime';
import type { DaemonHandle } from '../src/relay/daemonRuntime';
import { readSecret } from '../src/relay/secret';
import { TEST_REALM } from './helpers/daemonHarness';
import { getFreePort, httpReq } from './helpers/relayHarness';

// `daemon.js stop|status` against scratch daemons only. Nothing here uses the live
// relay port, and nothing signals a process: stop goes through the authenticated API.

let stateDir: string;
const daemons: DaemonHandle[] = [];
const occupants: http.Server[] = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-relay-test-cli-'));
});

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop('test cleanup')));
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

async function launch(): Promise<{ daemon: DaemonHandle; port: number }> {
  const port = await getFreePort();
  const daemon = await startDaemon({
    settings: { realm: TEST_REALM, port, stateDir, idleMs: 0, lockTtlMs: 60_000, lockWaitMs: 250 },
    build: { buildVersion: '1.0.0+cli00001', buildTime: '2026-10-15T00:00:00.000Z' },
  });
  daemons.push(daemon);
  return { daemon, port };
}

async function occupy(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; requests: string[] }> {
  const port = await getFreePort();
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  occupants.push(server);
  return { port, requests };
}

function capture(): { out: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), text: () => lines.join('\n') };
}

describe('parseDaemonArgs', () => {
  it('defaults to start with no overrides', () => {
    expect(parseDaemonArgs([])).toEqual({ command: 'start', foreground: false });
  });

  it.each([
    [['stop'], { command: 'stop', foreground: false }],
    [['status', '--port', '3799'], { command: 'status', port: 3799, foreground: false }],
    [['start', '--port=3799', '--foreground'], { command: 'start', port: 3799, foreground: true }],
    [['--foreground'], { command: 'start', foreground: true }],
    [['help'], { command: 'help', foreground: false }],
    [['--help'], { command: 'help', foreground: false }],
  ])('parses %j', (argv, expected) => {
    expect(parseDaemonArgs(argv)).toEqual(expected);
  });

  it.each([[['launch']], [['start', '--port']], [['start', '--port', 'abc']], [['stop', '--port', '70000']], [['stop', '--port', '0']], [['start', '--nope']]])(
    'rejects %j with an explanatory error',
    (argv) => {
      expect(() => parseDaemonArgs(argv)).toThrow(/usage|port|unknown|command/i);
    },
  );
});

describe('showStatus', () => {
  it('describes a running daemon and exits 0', async () => {
    const { port } = await launch();
    const io = capture();

    const code = await showStatus({ port, stateDir, out: io.out });

    expect(code).toBe(0);
    expect(io.text()).toContain(`pid ${process.pid}`);
    expect(io.text()).toContain('1.0.0+cli00001');
    expect(io.text()).toContain(`port ${port}`);
    expect(io.text()).toContain(path.join(stateDir, `relay.${port}.log`));
    expect(io.text()).not.toContain(readSecret(stateDir) as string);
  });

  it('exits 1 when nothing is running', async () => {
    const io = capture();
    expect(await showStatus({ port: await getFreePort(), stateDir, out: io.out })).toBe(1);
    expect(io.text()).toMatch(/no relay/i);
  });

  it('recognises a legacy in-process relay and says how to deal with it', async () => {
    const { port } = await occupy((req, res) => {
      if (req.url === '/relay/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: true, realmUser: 'jane.quickbase.com' }));
      } else res.writeHead(404).end();
    });
    const io = capture();

    expect(await showStatus({ port, stateDir, out: io.out })).toBe(1);
    expect(io.text()).toMatch(/legacy|old-build|in-process/i);
  });
});

describe('stopDaemon', () => {
  it('stops a running daemon through the authenticated API and exits 0', async () => {
    const { daemon, port } = await launch();
    const io = capture();

    const code = await stopDaemon({ port, stateDir, out: io.out });

    expect(code).toBe(0);
    await expect(daemon.stopped).resolves.toBe('stop requested');
    expect(io.text()).toContain(`pid ${process.pid}`);
    expect(io.text()).not.toContain(readSecret(stateDir) as string);
  });

  it('exits 0 and says so when nothing is running', async () => {
    const io = capture();
    expect(await stopDaemon({ port: await getFreePort(), stateDir, out: io.out })).toBe(0);
    expect(io.text()).toMatch(/no relay is running/i);
  });

  it.each([
    ['a legacy in-process relay', (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.url === '/relay/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: false, realmUser: null }));
      } else res.writeHead(404).end();
    }],
    ['a program that is not a relay', (_req: http.IncomingMessage, res: http.ServerResponse) => res.writeHead(404).end()],
  ])('refuses, and sends nothing but GET probes, to %s', async (_label, handler) => {
    const { port, requests } = await occupy(handler);
    const io = capture();

    const code = await stopDaemon({ port, stateDir, out: io.out });

    expect(code).toBe(1);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.startsWith('GET '))).toBe(true);
  });

  it('exits 1 without stopping anything when the secret is rejected', async () => {
    const { port } = await launch();
    fs.writeFileSync(path.join(stateDir, 'relay.secret'), 'cd'.repeat(32)); // someone replaced the secret file
    const io = capture();

    expect(await stopDaemon({ port, stateDir, out: io.out })).toBe(1);

    expect(io.text()).toMatch(/rejected/i);
    expect(io.text()).not.toContain('cd'.repeat(32));
    expect((await httpReq('GET', port, '/relay/info')).statusCode).toBe(200); // still running
  });

  it('exits 1 when a daemon is running but this user has no secret file', async () => {
    const { port } = await launch();
    fs.rmSync(path.join(stateDir, 'relay.secret'));
    const io = capture();

    expect(await stopDaemon({ port, stateDir, out: io.out })).toBe(1);
    expect(io.text()).toMatch(/secret/i);
  });
});
