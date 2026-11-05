import http from 'node:http';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { RelayError } from '../src/relay/errors';
import { RemoteRelayClient } from '../src/relay/remote';
import type { RemoteRelayClientOptions } from '../src/relay/remote';
import { FakeBookmarklet, TEST_REALM, TEST_SECRET, TestDaemon, startTestDaemon } from './helpers/daemonHarness';
import { getFreePort, httpReq } from './helpers/relayHarness';

// RemoteRelayClient is what every MCP instance uses instead of binding the relay
// port. Daemons here are in-process on OS-assigned ports; nothing touches port 3737.

const daemons: TestDaemon[] = [];
const bookmarklets: FakeBookmarklet[] = [];
const spies: http.Server[] = [];
let ownerCounter = 0;

afterEach(async () => {
  await Promise.all(bookmarklets.splice(0).map((b) => b.stop()));
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  await Promise.all(
    spies.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

async function daemon(opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
  const d = await startTestDaemon(opts);
  daemons.push(d);
  return d;
}

async function bookmarklet(port: number, respond?: ConstructorParameters<typeof FakeBookmarklet>[1]): Promise<FakeBookmarklet> {
  const b = new FakeBookmarklet(port, respond);
  bookmarklets.push(b);
  await b.start();
  return b;
}

function client(port: number, over: Partial<RemoteRelayClientOptions> = {}): RemoteRelayClient {
  return new RemoteRelayClient({
    port,
    readSecret: () => TEST_SECRET,
    ensureDaemon: async () => ({ started: false }),
    ownerId: `owner-${++ownerCounter}`,
    ...over,
  });
}

interface Captured {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A stand-in daemon that records what it receives and answers as told. */
async function spy(handler: (req: Captured, res: http.ServerResponse) => void): Promise<{ port: number; seen: Captured[] }> {
  const seen: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      const captured: Captured = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(captured);
      handler(captured, res);
    });
  });
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  spies.push(server);
  return { port, seen };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const OK_ANSWER = { ok: true, result: { status: 200, data: { n: 1 } }, relay: { active: true, realmUser: 'jane.quickbase.com' } };

describe('request()', () => {
  it('relays through the daemon and returns the bookmarklet result', async () => {
    const d = await daemon();
    const b = await bookmarklet(d.port, () => ({ status: 200, data: { pipelines: [7] } }));
    const remote = client(d.port);

    const result = await remote.request('/api/v2/pipelines/query/paged', 'POST', { tags: [] }, { Accept: 'application/json' }, 'text');

    expect(result).toEqual({ status: 200, data: { pipelines: [7] } });
    expect(b.seen[0]).toMatchObject({
      path: '/api/v2/pipelines/query/paged',
      method: 'POST',
      body: { tags: [] },
      headers: { Accept: 'application/json' },
      responseType: 'text',
    });
  });

  it('serves two clients through the one bookmarklet and returns each its own result', async () => {
    const d = await daemon();
    await bookmarklet(d.port, (req) => ({ status: 200, data: { echo: req.path } }));
    const a = client(d.port);
    const b = client(d.port);

    const [ra, rb] = await Promise.all([a.request('/api/one', 'GET'), b.request('/api/two', 'GET')]);

    expect(ra.data).toEqual({ echo: '/api/one' });
    expect(rb.data).toEqual({ echo: '/api/two' });
  });

  it('tracks isActive and currentUser from the daemon, and refreshStatus() updates them', async () => {
    const d = await daemon();
    const remote = client(d.port);
    expect(remote.isActive).toBe(false);
    expect(remote.currentUser).toBeNull();

    await bookmarklet(d.port);
    await remote.refreshStatus();
    expect(remote.isActive).toBe(true);
    expect(remote.currentUser).toBe(TEST_REALM);

    await remote.request('/api/x', 'GET');
    expect(remote.isActive).toBe(true);
  });

  it('sends the secret and a plain JSON body, and never an Origin or Fetch Metadata header', async () => {
    const s = await spy((_req, res) => json(res, 200, OK_ANSWER));
    const remote = client(s.port, { ownerId: 'owner-spy' });

    await remote.request('/api/pipeohod/9', 'GET', undefined, { Accept: 'text/plain' }, 'text');

    expect(s.seen).toHaveLength(1);
    const [req] = s.seen;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/relay/rpc');
    expect(req.headers['x-qb-relay-secret']).toBe(TEST_SECRET);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.host).toBe(`127.0.0.1:${s.port}`);
    expect(Object.keys(req.headers).filter((h) => h === 'origin' || h.startsWith('sec-fetch-'))).toEqual([]);
    expect(JSON.parse(req.body)).toEqual({
      owner: 'owner-spy',
      path: '/api/pipeohod/9',
      method: 'GET',
      headers: { Accept: 'text/plain' },
      responseType: 'text',
    });
  });

  it('validates locally: a bad path never reaches the daemon or even starts it', async () => {
    const s = await spy((_req, res) => json(res, 200, OK_ANSWER));
    const ensureDaemon = jest.fn(async () => ({ started: false }));
    const remote = client(s.port, { ensureDaemon });

    await expect(remote.request('https://evil.example/steal', 'GET')).rejects.toMatchObject({
      kind: 'invalid',
      code: ErrorCode.InvalidParams,
    });

    expect(s.seen).toEqual([]);
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it('never puts a secret in an error message', async () => {
    const s = await spy((_req, res) => json(res, 500, { ok: false, kind: 'internal', message: 'boom' }));
    const remote = client(s.port);
    const error = await remote.request('/api/x', 'GET').catch((e: Error) => e);
    expect((error as Error).message).not.toContain(TEST_SECRET);
  });
});

describe('error mapping', () => {
  it('rebuilds a RelayError (an McpError) of kind not_active with the daemon-supplied setup text', async () => {
    const d = await daemon();
    const remote = client(d.port);

    const error = await remote.request('/api/x', 'GET').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RelayError);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ kind: 'not_active', code: ErrorCode.InternalError });
    expect((error as Error).message).toContain('relay is not active');
    expect((error as Error).message).toContain(`http://localhost:${d.port}/setup`);
    expect((error as Error).message.match(/MCP error/g)).toHaveLength(1); // not double-prefixed
  });

  it('maps a daemon-side timeout to kind timeout', async () => {
    const d = await daemon({ requestTimeoutMs: 120 });
    await bookmarklet(d.port, () => new Promise(() => {}));
    const remote = client(d.port);

    await expect(remote.request('/api/x', 'GET')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it.each([
    [400, { ok: false, kind: 'invalid', message: 'bad path' }, 'invalid', ErrorCode.InvalidParams],
    [423, { ok: false, kind: 'busy', message: 'held by owner-x' }, 'busy', ErrorCode.InternalError],
    [503, { ok: false, kind: 'shutting_down', message: 'going down' }, 'shutting_down', ErrorCode.InternalError],
    [500, { ok: false, kind: 'internal', message: 'oops' }, 'internal', ErrorCode.InternalError],
  ])('maps HTTP %i to kind %s', async (status, answer, kind, code) => {
    const s = await spy((_req, res) => json(res, status, answer));
    const remote = client(s.port);

    await expect(remote.request('/api/x', 'GET')).rejects.toMatchObject({ kind, code, detail: answer.message });
  });

  it('reports an unintelligible answer as an internal error naming the HTTP status', async () => {
    const s = await spy((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>Bad gateway</html>');
    });
    const remote = client(s.port);

    await expect(remote.request('/api/x', 'GET')).rejects.toMatchObject({
      kind: 'internal',
      detail: expect.stringContaining('502'),
    });
  });
});

describe('starting the daemon lazily', () => {
  it('does nothing at construction, then starts the daemon once for any number of concurrent requests', async () => {
    const d = await daemon();
    await bookmarklet(d.port);
    const ensureDaemon = jest.fn(async () => ({ started: false }));
    const remote = client(d.port, { ensureDaemon });
    expect(ensureDaemon).not.toHaveBeenCalled();

    await Promise.all([remote.request('/api/a', 'GET'), remote.request('/api/b', 'GET'), remote.request('/api/c', 'GET')]);
    await remote.request('/api/d', 'GET');

    expect(ensureDaemon).toHaveBeenCalledTimes(1);
  });

  it('reports an actionable "unavailable" error when the daemon cannot be started, and tries again next time', async () => {
    const s = await spy((_req, res) => json(res, 200, OK_ANSWER)); // a daemon that is reachable once the launcher succeeds
    const ensureDaemon = jest
      .fn<Promise<{ started: boolean }>, []>()
      .mockRejectedValueOnce(new Error('Port 1234 is held by another program; set QB_RELAY_PORT'))
      .mockResolvedValue({ started: false });
    const remote = client(s.port, { ensureDaemon });

    const error = await remote.request('/api/x', 'GET').catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'unavailable' });
    expect((error as Error).message).toContain('Port 1234 is held by another program');
    expect(s.seen).toEqual([]);
    await expect(remote.request('/api/x', 'GET')).resolves.toMatchObject({ status: 200 });
    expect(ensureDaemon).toHaveBeenCalledTimes(2);
  });
});

describe('warmUp() (called at MCP startup)', () => {
  it('starts the daemon in the background, and the first request does not start it again', async () => {
    const d = await daemon();
    await bookmarklet(d.port);
    const ensureDaemon = jest.fn(async () => ({ started: false }));
    const remote = client(d.port, { ensureDaemon });

    await remote.warmUp();
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
    await remote.request('/api/x', 'GET');

    expect(ensureDaemon).toHaveBeenCalledTimes(1);
  });

  it('never rejects: a launcher failure is swallowed and surfaces (and is retried) on the next request', async () => {
    const s = await spy((_req, res) => json(res, 200, OK_ANSWER));
    const ensureDaemon = jest
      .fn<Promise<{ started: boolean }>, []>()
      .mockRejectedValueOnce(new Error('port busy'))
      .mockResolvedValue({ started: false });
    const remote = client(s.port, { ensureDaemon });

    await expect(remote.warmUp()).resolves.toBeUndefined();
    await expect(remote.request('/api/x', 'GET')).resolves.toMatchObject({ status: 200 });

    expect(ensureDaemon).toHaveBeenCalledTimes(2);
  });
});

describe('recovering from a daemon restart', () => {
  it('starts the daemon again when the connection is refused, then retries the request once', async () => {
    const first = await daemon();
    const port = first.port;
    await bookmarklet(port, (req) => ({ status: 200, data: { echo: req.path } }));
    const ensureDaemon = jest.fn(async () => ({ started: false }));
    const remote = client(port, { ensureDaemon });
    await remote.request('/api/before', 'GET');
    expect(ensureDaemon).toHaveBeenCalledTimes(1);

    await first.close(); // the daemon goes away (idle exit, crash, upgrade)...
    daemons.splice(daemons.indexOf(first), 1);
    ensureDaemon.mockImplementation(async () => {
      daemons.push(await startTestDaemon({ port })); // ...and ensureDaemon brings a new one up on the same port
      return { started: true };
    });

    const result = await remote.request('/api/after', 'GET');

    expect(result.data).toEqual({ echo: '/api/after' });
    expect(ensureDaemon).toHaveBeenCalledTimes(2);
  });

  it('waits for the already-open bookmarklet to re-attach after a fresh start, within the allowed time', async () => {
    const d = await daemon();
    const remote = client(d.port, { ensureDaemon: async () => ({ started: true }), reattachWaitMs: 3000 });
    setTimeout(() => void bookmarklet(d.port), 250); // the tab re-hellos a moment later

    await expect(remote.request('/api/x', 'GET')).resolves.toMatchObject({ status: 200 });
  });

  it('gives up with not_active when the bookmarklet does not re-attach in time', async () => {
    const d = await daemon();
    const remote = client(d.port, { ensureDaemon: async () => ({ started: true }), reattachWaitMs: 100 });

    await expect(remote.request('/api/x', 'GET')).rejects.toMatchObject({ kind: 'not_active' });
  });

  it('does not wait for re-attachment when the daemon was already running', async () => {
    const d = await daemon();
    const remote = client(d.port, { ensureDaemon: async () => ({ started: false }), reattachWaitMs: 5000 });
    const started = Date.now();

    await expect(remote.request('/api/x', 'GET')).rejects.toMatchObject({ kind: 'not_active' });

    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('never retries after a reset or timeout, because the request may already have run', async () => {
    const s = await spy((_req, res) => res.socket?.destroy());
    const ensureDaemon = jest.fn(async () => ({ started: false }));
    const remote = client(s.port, { ensureDaemon });

    await expect(remote.request('/api/x', 'POST')).rejects.toMatchObject({ kind: 'unavailable' });

    expect(s.seen).toHaveLength(1);
    expect(ensureDaemon).toHaveBeenCalledTimes(1);
  });

  it('gives up on an unanswered request after the RPC timeout, without retrying', async () => {
    const s = await spy(() => {}); // never answers
    const remote = client(s.port, { rpcTimeoutMs: 150 });

    const error = await remote.request('/api/x', 'GET').catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'unavailable' });
    expect((error as Error).message).toMatch(/did not answer/i);
    expect(s.seen).toHaveLength(1);
  });

  it('reports unavailable when the daemon is gone and cannot be started again', async () => {
    const first = await daemon();
    const port = first.port;
    const ensureDaemon = jest.fn<Promise<{ started: boolean }>, []>().mockResolvedValueOnce({ started: false });
    const remote = client(port, { ensureDaemon });
    await bookmarklet(port);
    await remote.request('/api/before', 'GET');
    await first.close();
    daemons.splice(daemons.indexOf(first), 1);
    ensureDaemon.mockRejectedValue(new Error('could not start the relay daemon (see relay.3737.log)'));

    const error = await remote.request('/api/after', 'GET').catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'unavailable' });
    expect((error as Error).message).toContain('see relay.3737.log');
  });
});

describe('the shared secret', () => {
  it('re-reads the secret once when the daemon rejects it, then succeeds', async () => {
    const d = await daemon();
    await bookmarklet(d.port);
    const readSecret = jest.fn().mockReturnValueOnce('cd'.repeat(32)).mockReturnValue(TEST_SECRET);
    const remote = client(d.port, { readSecret });

    await expect(remote.request('/api/x', 'GET')).resolves.toMatchObject({ status: 200 });
    expect(readSecret).toHaveBeenCalledTimes(2);
  });

  it('gives up with an actionable message when the secret stays wrong', async () => {
    const d = await daemon();
    const readSecret = jest.fn().mockReturnValue('cd'.repeat(32));
    const remote = client(d.port, { readSecret });

    const error = await remote.request('/api/x', 'GET').catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'unavailable' });
    expect((error as Error).message).toContain('relay:stop');
    expect((error as Error).message).not.toContain('cd'.repeat(32));
    expect(readSecret).toHaveBeenCalledTimes(2);
  });
});

describe('the impersonation lock between clients', () => {
  it('names the holder and fails with kind busy when another client holds the lock', async () => {
    const d = await daemon({ lockWaitMs: 120 });
    await bookmarklet(d.port);
    const a = client(d.port);
    const b = client(d.port);
    await a.acquireExclusive();

    const request = await b.request('/api/x', 'GET').catch((e: unknown) => e);
    const acquire = await b.acquireExclusive().catch((e: unknown) => e);

    expect(request).toMatchObject({ kind: 'busy' });
    expect((request as Error).message).toContain(a.ownerId);
    expect(acquire).toMatchObject({ kind: 'busy' });
  });

  it("holds another client's request until the whole sequence has ended and the lock is released", async () => {
    const d = await daemon({ lockWaitMs: 5000 });
    const bm = await bookmarklet(d.port);
    const a = client(d.port);
    const b = client(d.port);

    await a.acquireExclusive();
    const bResult = b.request('/api/b-request', 'GET');
    await new Promise((r) => setTimeout(r, 100));
    await a.request('/api/impersonation/realm/start', 'POST', { qb_user_id: '1' });
    await a.request('/api/a-work', 'GET');
    await a.request('/api/impersonation/end', 'POST', {});
    expect(bm.seen.map((r) => r.path)).not.toContain('/api/b-request');
    await a.releaseExclusive();
    await bResult;

    expect(bm.seen.map((r) => r.path)).toEqual([
      '/api/impersonation/realm/start',
      '/api/a-work',
      '/api/impersonation/end',
      '/api/b-request',
    ]);
  });

  it('lets a waiting client acquire as soon as the holder releases', async () => {
    const d = await daemon({ lockWaitMs: 5000 });
    const a = client(d.port);
    const b = client(d.port);
    await a.acquireExclusive();
    const waiting = b.acquireExclusive();

    await a.releaseExclusive();

    await expect(waiting).resolves.toBeUndefined();
    expect(((await httpReq('GET', d.port, '/relay/status')).body as { lock: { owner: string } }).lock.owner).toBe(b.ownerId);
  });
});

describe('owner ids', () => {
  it('default to a distinct, wire-safe id per client', () => {
    const one = new RemoteRelayClient({ port: 1, readSecret: () => TEST_SECRET, ensureDaemon: async () => ({ started: false }) });
    const two = new RemoteRelayClient({ port: 1, readSecret: () => TEST_SECRET, ensureDaemon: async () => ({ started: false }) });

    expect(one.ownerId).not.toBe(two.ownerId);
    for (const id of [one.ownerId, two.ownerId]) expect(id).toMatch(/^[A-Za-z0-9._:-]{1,200}$/);
    expect(one.ownerId).toContain(String(process.pid));
  });
});
