import http from 'node:http';
import { RelayAlreadyRunningError } from '../src/relay/errors';
import { probeRelay } from '../src/relay/probe';
import { startRelayServer } from '../src/relay/server';
import { TEST_REALM, TestDaemon, makeTestInfo, startTestDaemon } from './helpers/daemonHarness';
import { getFreePort } from './helpers/relayHarness';

// What is on the relay port? Plus: what a newcomer does when the port is taken.
// Only OS-assigned ports are used; nothing here touches the live relay port.

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const occupants: http.Server[] = [];
const daemons: TestDaemon[] = [];

async function occupy(handler: Handler, port?: number): Promise<{ port: number; requests: string[] }> {
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

const json = (status: number, body: unknown): Handler => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** An old-build relay: no /relay/info, and a status body of exactly { active, realmUser }. */
const legacyRelay = (active: boolean, realmUser: string | null): Handler => (req, res) => {
  if (req.url === '/relay/status') return json(200, { active, realmUser })(req, res);
  res.writeHead(404).end();
};

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
});

describe('probeRelay', () => {
  it('reports nothing listening', async () => {
    const port = await getFreePort();
    await expect(probeRelay(port, 500)).resolves.toEqual({ kind: 'none' });
  });

  it('recognises a relay daemon and returns its info', async () => {
    const d = await startTestDaemon({ info: { pid: 9001 } });
    daemons.push(d);

    await expect(probeRelay(d.port, 1000)).resolves.toEqual({ kind: 'daemon', info: makeTestInfo({ pid: 9001 }) });
  });

  it.each([
    [true, 'jane.quickbase.com'],
    [false, null],
  ])('recognises a legacy in-process relay (active=%s)', async (active, realmUser) => {
    const { port } = await occupy(legacyRelay(active, realmUser));

    await expect(probeRelay(port, 1000)).resolves.toEqual({ kind: 'legacy', status: { active, realmUser } });
  });

  it.each([
    ['answers 404 to everything', (_req: http.IncomingMessage, res: http.ServerResponse) => res.writeHead(404).end()],
    ['answers with HTML', (_req: http.IncomingMessage, res: http.ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>')],
    ['returns JSON of the wrong shape from /relay/info', json(200, { hello: 'world' })],
    ['returns an info object with wrong field types', json(200, { protocolVersion: '1', pid: 'x', buildVersion: 5 })],
    ['returns a status object with extra, unknown fields', (req: http.IncomingMessage, res: http.ServerResponse) =>
      req.url === '/relay/status' ? json(200, { active: true, realmUser: null, somethingElse: 1 })(req, res) : res.writeHead(404).end()],
  ])('treats a server that %s as a foreign program', async (_label, handler) => {
    const { port } = await occupy(handler);

    await expect(probeRelay(port, 1000)).resolves.toEqual({ kind: 'foreign' });
  });

  it('treats a server that never answers as foreign once the timeout passes', async () => {
    const { port } = await occupy(() => {});

    const started = Date.now();
    await expect(probeRelay(port, 150)).resolves.toEqual({ kind: 'foreign' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('startRelayServer on a port that is already taken', () => {
  it('makes the newcomer stand down quickly when a healthy daemon holds the port, and never sends it a shutdown', async () => {
    const d = await startTestDaemon({ info: { pid: 4711 } });
    daemons.push(d);
    const log: string[] = [];

    const newcomer = startRelayServer(TEST_REALM, d.port, { log: (line) => log.push(line) });
    const started = Date.now();

    await expect(newcomer.ready).rejects.toBeInstanceOf(RelayAlreadyRunningError);
    await newcomer.ready.catch((err: RelayAlreadyRunningError) => expect(err.info.pid).toBe(4711));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(log.join('\n')).toMatch(/already running/i);
    expect(d.stopReasons).toEqual([]);
    expect(d.logs.join('\n')).not.toMatch(/shutdown/i);
    await newcomer.close();
  });

  it('never POSTs /relay/shutdown to a legacy relay that holds the port (replacement is the launcher\'s explicit decision)', async () => {
    const { port, requests } = await occupy(legacyRelay(true, 'jane.quickbase.com'));
    const newcomer = startRelayServer(TEST_REALM, port, { log: () => {} });

    await new Promise((r) => setTimeout(r, 1500)); // covers the first retries

    expect(requests.some((r) => r.startsWith('POST'))).toBe(false);
    await newcomer.close();
  });

  it('does not raise an unhandled rejection when nobody awaits ready', async () => {
    const d = await startTestDaemon();
    daemons.push(d);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    const newcomer = startRelayServer(TEST_REALM, d.port, { log: () => {} });
    await new Promise((r) => setTimeout(r, 800));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    await newcomer.close();
  });

  it('stops retrying and resolves when closed while waiting for a busy port', async () => {
    const { port } = await occupy((_req, res) => res.writeHead(404).end());
    const newcomer = startRelayServer(TEST_REALM, port, { log: () => {} });
    await new Promise((r) => setTimeout(r, 200));

    await expect(newcomer.close()).resolves.toBeUndefined();
    await expect(newcomer.ready).rejects.toBeDefined();
  });
});

describe('RelayServer.close', () => {
  it('releases the port so another server can bind it, and is safe to call twice', async () => {
    const port = await getFreePort();
    const first = startRelayServer(TEST_REALM, port, { log: () => {} });
    await first.ready;

    await first.close();
    await first.close();

    const second = startRelayServer(TEST_REALM, port, { log: () => {} });
    await expect(second.ready).resolves.toBeUndefined();
    await second.close();
  });

  it('rejects requests still pending with a shutting-down error', async () => {
    const port = await getFreePort();
    const server = startRelayServer(TEST_REALM, port, { log: () => {} });
    await server.ready;
    server.client.receiveHello('tok', TEST_REALM);
    const pending = server.client.request('/api/x', 'GET');

    const closing = server.close();

    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('shutting down') });
    await closing;
  });
});
