import { startRelayServer } from '../src/relay/server';
import { FakeBookmarklet, TEST_ORIGIN, TEST_REALM, TEST_SECRET, TestDaemon, makeTestInfo, startTestDaemon } from './helpers/daemonHarness';
import { getFreePort, httpReq, httpReqFull } from './helpers/relayHarness';

// Control API of the shared relay daemon: /relay/info, /relay/rpc, /relay/lock/*,
// /relay/stop, the refused legacy /relay/shutdown, status extras, and log hygiene.
// Every daemon binds an OS-assigned free port; nothing here touches port 3737.

const daemons: TestDaemon[] = [];
const bookmarklets: FakeBookmarklet[] = [];

async function daemon(opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
  const d = await startTestDaemon(opts);
  daemons.push(d);
  return d;
}

async function bookmarklet(d: TestDaemon, respond?: ConstructorParameters<typeof FakeBookmarklet>[1]): Promise<FakeBookmarklet> {
  const b = new FakeBookmarklet(d.port, respond);
  bookmarklets.push(b);
  await b.start();
  return b;
}

afterEach(async () => {
  await Promise.all(bookmarklets.splice(0).map((b) => b.stop()));
  await Promise.all(daemons.splice(0).map((d) => d.close()));
});

const CONTROL_ENDPOINTS = ['/relay/rpc', '/relay/lock/acquire', '/relay/lock/release', '/relay/stop'] as const;

/** A well-formed body for each control endpoint. */
function validBody(path: string): Record<string, unknown> {
  switch (path) {
    case '/relay/rpc':
      return { owner: 'owner-a', path: '/api/pipeohod/1', method: 'GET' };
    case '/relay/lock/acquire':
    case '/relay/lock/release':
      return { owner: 'owner-a' };
    default:
      return { ifIdle: true };
  }
}

describe('GET /relay/info', () => {
  it('reports protocol, build, pid, start time and realm, and nothing secret', async () => {
    const d = await daemon({ info: { pid: 31337 } });

    const res = await httpReqFull('GET', d.port, '/relay/info');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(makeTestInfo({ pid: 31337 }));
    expect(JSON.stringify(res.body)).not.toContain(TEST_SECRET);
  });

  it('refuses a request that carries any Origin header (a web page may not read it)', async () => {
    const d = await daemon();
    for (const origin of [TEST_ORIGIN, 'https://evil.example', '', 'null']) {
      const res = await httpReqFull('GET', d.port, '/relay/info', undefined, { Origin: origin });
      expect(res.statusCode).toBe(403);
    }
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const d = await daemon();
    const res = await httpReqFull('GET', d.port, '/relay/info', undefined, { Host: 'rebound.evil.example' });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /relay/status in daemon mode', () => {
  it('adds daemon identity, uptime, client count, queue depth and lock state', async () => {
    const d = await daemon({ info: { pid: 777 } });

    const res = await httpReqFull('GET', d.port, '/relay/status');

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      active: false,
      realmUser: null,
      pid: 777,
      protocolVersion: 1,
      buildVersion: '1.0.0+test0001',
      startedAt: '2026-10-15T00:00:00.000Z',
      clients: 0,
      pending: 0,
      queued: 0,
      lock: { held: false },
    });
    expect(typeof (res.body as { uptimeSec: number }).uptimeSec).toBe('number');
  });

  it('counts distinct recent clients and names the lock holder', async () => {
    const d = await daemon({ lockWaitMs: 50 });
    await d.lockAcquire('owner-a');
    await d.rpc('owner-b', '/api/x'); // waits out the lock limit and is refused, but the client is still counted

    const res = await httpReqFull('GET', d.port, '/relay/status');

    expect(res.body).toMatchObject({ clients: 2, lock: { held: true, owner: 'owner-a' } });
  });
});

describe('legacy POST /relay/shutdown', () => {
  it.each([
    ['no Origin, no secret (an old-build newcomer)', {}],
    ['the QB realm Origin', { Origin: TEST_ORIGIN }],
    ['a foreign Origin', { Origin: 'https://evil.example' }],
    ['the right secret', { 'X-QB-Relay-Secret': TEST_SECRET }],
  ])('is always refused with 403 (%s) and the daemon keeps serving', async (_label, headers) => {
    const d = await daemon();

    const res = await httpReqFull('POST', d.port, '/relay/shutdown', '{}', headers);
    const after = await httpReqFull('GET', d.port, '/relay/info');

    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).toContain('relay:stop');
    expect(after.statusCode).toBe(200);
    expect(d.stopReasons).toEqual([]);
  });
});

describe.each(CONTROL_ENDPOINTS)('%s authentication and browser defences', (endpoint) => {
  it('rejects a missing secret with 401 and has no side effect', async () => {
    const d = await daemon();
    const res = await d.call(endpoint, validBody(endpoint));
    expect(res.statusCode).toBe(401);
    expect(d.stopReasons).toEqual([]);
    expect(d.activity.count).toBe(0); // unauthenticated traffic must not keep the daemon alive
    expect((await httpReqFull('GET', d.port, '/relay/status')).body).toMatchObject({ lock: { held: false }, clients: 0 });
  });

  it.each([
    ['wrong secret of the same length', 'cd'.repeat(32)],
    ['secret of a different length', 'ab'.repeat(31)],
    ['empty secret', ''],
    ['the secret with a suffix', `${TEST_SECRET}x`],
  ])('rejects %s with 401', async (_label, secret) => {
    const d = await daemon();
    const res = await d.call(endpoint, validBody(endpoint), { 'X-QB-Relay-Secret': secret });
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(TEST_SECRET);
  });

  it.each([TEST_ORIGIN, 'https://evil.example', '', 'null'])(
    'rejects a request carrying Origin %j with 403 even when the secret is right',
    async (origin) => {
      const d = await daemon();
      const res = await d.call(endpoint, validBody(endpoint), { ...d.authHeaders, Origin: origin });
      expect(res.statusCode).toBe(403);
      expect(d.stopReasons).toEqual([]);
    },
  );

  it.each([
    ['Sec-Fetch-Mode', 'cors'],
    ['Sec-Fetch-Site', 'cross-site'],
    ['Sec-Fetch-Dest', 'empty'],
  ])('rejects a browser-issued request (%s present) with 403 even when the secret is right', async (header, value) => {
    const d = await daemon();
    const res = await d.call(endpoint, validBody(endpoint), { ...d.authHeaders, [header]: value });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a foreign Host header with 403 even when the secret is right (DNS rebinding)', async () => {
    const d = await daemon();
    const res = await d.call(endpoint, validBody(endpoint), { ...d.authHeaders, Host: 'rebound.evil.example' });
    expect(res.statusCode).toBe(403);
  });

  it('answers 404 to a GET', async () => {
    const d = await daemon();
    const res = await httpReqFull('GET', d.port, endpoint, undefined, d.authHeaders);
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /relay/rpc request validation', () => {
  it.each([
    ['an off-API path', { path: 'https://evil.example/api/x' }],
    ['a traversal path', { path: '/api/../admin' }],
    ['an encoded traversal path', { path: '/api/%2e%2e/admin' }],
    ['a fullwidth at-sign path', { path: '/api/x＠evil.example' }],
    ['a protocol-relative path', { path: '//evil.example/api/x' }],
    ['an invalid method', { method: 'TRACE' }],
    ['a forbidden header', { headers: { 'X-CSRFToken': 'stolen' } }],
    ['a malformed header value', { headers: { 'X-Custom': 'a\r\nInjected: 1' } }],
    ['an invalid responseType', { responseType: 'html' }],
    ['a missing owner', { owner: undefined }],
    ['an empty owner', { owner: '' }],
    ['an over-long owner', { owner: 'o'.repeat(201) }],
    ['an owner with illegal characters', { owner: 'owner a/../b' }],
    ["the daemon's internal cleanup owner (a client may not claim it)", { owner: '<expired-hold-cleanup>' }],
  ])('rejects %s with 400 kind "invalid" and queues nothing', async (_label, overrides) => {
    const d = await daemon();
    const b = await bookmarklet(d);

    const res = await d.call('/relay/rpc', { owner: 'owner-a', path: '/api/x', method: 'GET', ...overrides }, d.authHeaders);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ ok: false, kind: 'invalid' });
    expect(b.seen).toEqual([]);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const d = await daemon();
    const res = await httpReqFull('POST', d.port, '/relay/rpc', 'not-json{{{', d.authHeaders);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body over 1 MB (400, or the connection is reset)', async () => {
    const d = await daemon();
    const huge = JSON.stringify({ owner: 'owner-a', path: '/api/x', method: 'POST', body: 'x'.repeat(1_050_000) });
    const res = await httpReqFull('POST', d.port, '/relay/rpc', huge, d.authHeaders).catch((err: Error) => {
      if (!/socket hang up|ECONNRESET|EPIPE/.test(err.message)) throw err;
      return { statusCode: 400 };
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /relay/rpc relaying', () => {
  it('answers 503 kind "not_active" with setup instructions when no bookmarklet is connected', async () => {
    const d = await daemon();

    const res = await d.rpc('owner-a', '/api/pipeohod/1');

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ ok: false, kind: 'not_active', relay: { active: false, realmUser: null } });
    const message = (res.body as { message: string }).message;
    expect(message).toContain('relay is not active');
    expect(message).toContain(`http://localhost:${d.port}/setup`);
    expect(message).not.toContain('restart it completely');
  });

  it('delivers the request to the bookmarklet unchanged and returns its result', async () => {
    const d = await daemon();
    const b = await bookmarklet(d, () => ({ status: 200, data: { pipelines: [1, 2] } }));

    const res = await d.rpc('owner-a', '/api/v2/pipelines/query/paged?pageNumber=1', {
      method: 'POST',
      body: { tags: [] },
      headers: { Accept: 'application/json' },
      responseType: 'text',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      result: { status: 200, data: { pipelines: [1, 2] } },
      relay: { active: true, realmUser: TEST_REALM },
    });
    expect(b.seen).toHaveLength(1);
    expect(b.seen[0]).toMatchObject({
      path: '/api/v2/pipelines/query/paged?pageNumber=1',
      method: 'POST',
      body: { tags: [] },
      headers: { Accept: 'application/json' },
      responseType: 'text',
    });
  });

  it('passes through error statuses from QuickBase as ordinary results', async () => {
    const d = await daemon();
    await bookmarklet(d, () => ({ status: 403, data: { message: 'nope' } }));

    const res = await d.rpc('owner-a', '/api/pipeohod/1');

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, result: { status: 403 } });
  });

  it('answers 504 kind "timeout" with reconnect instructions when the bookmarklet never answers', async () => {
    const d = await daemon({ requestTimeoutMs: 150 });
    await bookmarklet(d, () => new Promise(() => {})); // takes the request and never replies

    const res = await d.rpc('owner-a', '/api/pipeohod/1');

    expect(res.statusCode).toBe(504);
    expect(res.body).toMatchObject({ ok: false, kind: 'timeout' });
    expect((res.body as { message: string }).message).toContain('timed out');
  });

  it('serves two clients in order and returns each its own result', async () => {
    const d = await daemon();
    await bookmarklet(d, (req) => ({ status: 200, data: { echo: req.path } }));

    const [a, b] = await Promise.all([d.rpc('owner-a', '/api/one'), d.rpc('owner-b', '/api/two')]);

    expect(a.body).toMatchObject({ ok: true, result: { data: { echo: '/api/one' } } });
    expect(b.body).toMatchObject({ ok: true, result: { data: { echo: '/api/two' } } });
  });
});

describe('impersonation lock over HTTP', () => {
  it('grants a free lock and refuses a second owner after the wait limit, naming the holder', async () => {
    const d = await daemon({ lockWaitMs: 120 });

    expect((await d.lockAcquire('owner-a')).body).toMatchObject({ ok: true });
    const busy = await d.lockAcquire('owner-b');

    expect(busy.statusCode).toBe(423);
    expect(busy.body).toMatchObject({ ok: false, kind: 'busy', holder: { owner: 'owner-a' } });
    expect((busy.body as { message: string }).message).toContain('owner-a');
  });

  it('grants a waiting owner as soon as the holder releases', async () => {
    const d = await daemon({ lockWaitMs: 3000 });
    await d.lockAcquire('owner-a');
    const waiting = d.lockAcquire('owner-b');

    const released = await d.lockRelease('owner-a');
    const granted = await waiting;

    expect(released.body).toEqual({ ok: true, released: true });
    expect(granted.body).toMatchObject({ ok: true });
  });

  it('reports released:false for an owner that does not hold the lock', async () => {
    const d = await daemon();
    await d.lockAcquire('owner-a');
    expect((await d.lockRelease('owner-b')).body).toEqual({ ok: true, released: false });
    expect((await httpReqFull('GET', d.port, '/relay/status')).body).toMatchObject({ lock: { held: true, owner: 'owner-a' } });
  });

  it('caps a client-requested wait at the daemon maximum', async () => {
    const d = await daemon({ lockWaitMs: 100 });
    await d.lockAcquire('owner-a');
    const started = Date.now();

    const res = await d.lockAcquire('owner-b', 60_000);

    expect(res.statusCode).toBe(423);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("makes another client's request wait for the holder's whole start -> call -> end sequence", async () => {
    const d = await daemon({ lockWaitMs: 5000 });
    const b = await bookmarklet(d);
    await d.lockAcquire('owner-a');

    const others = d.rpc('owner-b', '/api/b-request'); // arrives while A holds the lock
    await new Promise((r) => setTimeout(r, 100));
    await d.rpc('owner-a', '/api/impersonation/realm/start');
    await d.rpc('owner-a', '/api/a-work');
    await d.rpc('owner-a', '/api/impersonation/end');
    expect(b.seen.map((r) => r.path)).not.toContain('/api/b-request'); // still waiting
    await d.lockRelease('owner-a');
    const result = await others;

    expect(result.body).toMatchObject({ ok: true });
    expect(b.seen.map((r) => r.path)).toEqual([
      '/api/impersonation/realm/start',
      '/api/a-work',
      '/api/impersonation/end',
      '/api/b-request',
    ]);
  });

  it("answers 423 busy to a client's request that waits longer than the limit, without queueing it", async () => {
    const d = await daemon({ lockWaitMs: 120 });
    const b = await bookmarklet(d);
    await d.lockAcquire('owner-a');

    const res = await d.rpc('owner-b', '/api/b-request');

    expect(res.statusCode).toBe(423);
    expect(res.body).toMatchObject({ ok: false, kind: 'busy', holder: { owner: 'owner-a' } });
    expect(b.seen).toEqual([]);
  });

  it('ends an abandoned impersonation through the bookmarklet before the next client runs (TTL expiry)', async () => {
    const d = await daemon({ lockTtlMs: 200, lockWaitMs: 5000 });
    const b = await bookmarklet(d);
    await d.lockAcquire('owner-a'); // then goes silent

    const res = await d.rpc('owner-b', '/api/b-request');

    expect(res.body).toMatchObject({ ok: true });
    expect(b.seen.map((r) => [r.method, r.path])).toEqual([
      ['POST', '/api/impersonation/end'],
      ['GET', '/api/b-request'],
    ]);
    expect(d.logs.join('\n')).toMatch(/expired/i);
  });
});

describe('POST /relay/stop', () => {
  it('stops the daemon on request: answers 200 then calls onStop once', async () => {
    const d = await daemon();

    const res = await d.call('/relay/stop', {}, d.authHeaders);
    await new Promise((r) => setTimeout(r, 30));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(d.stopReasons).toEqual(['stop requested']);
  });

  it('with ifIdle:true stops an idle daemon', async () => {
    const d = await daemon();
    const res = await d.call('/relay/stop', { ifIdle: true }, d.authHeaders);
    await new Promise((r) => setTimeout(r, 30));
    expect(res.statusCode).toBe(200);
    expect(d.stopReasons).toEqual(['stop requested (idle replacement)']);
  });

  it('with ifIdle:true refuses (409) while a bookmarklet is connected', async () => {
    const d = await daemon();
    await bookmarklet(d);

    const res = await d.call('/relay/stop', { ifIdle: true }, d.authHeaders);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ ok: false, kind: 'busy' });
    expect(d.stopReasons).toEqual([]);
  });

  it('with ifIdle:true refuses (409) while the impersonation lock is held', async () => {
    const d = await daemon();
    await d.lockAcquire('owner-a');
    const res = await d.call('/relay/stop', { ifIdle: true }, d.authHeaders);
    expect(res.statusCode).toBe(409);
    expect(d.stopReasons).toEqual([]);
  });

  it('with ifIdle:true refuses (409) while a request is waiting for the bookmarklet', async () => {
    const d = await daemon();
    d.client.receiveHello('tok', TEST_REALM); // active, but no bookmarklet polling: the request stays queued
    const queued = d.client.request('/api/x', 'GET').catch(() => undefined);

    const res = await d.call('/relay/stop', { ifIdle: true }, d.authHeaders);

    expect(res.statusCode).toBe(409);
    expect(d.stopReasons).toEqual([]);
    d.client.shutdown();
    await queued;
  });
});

describe('activity hook (drives the idle timeout)', () => {
  it('fires for rpc, lock, hello, poll and result traffic but not for probes or the setup page', async () => {
    const d = await daemon();

    await httpReqFull('GET', d.port, '/relay/info');
    await httpReqFull('GET', d.port, '/relay/status');
    await httpReqFull('GET', d.port, '/setup');
    expect(d.activity.count).toBe(0);

    await d.lockAcquire('owner-a');
    expect(d.activity.count).toBe(1);
    await d.lockRelease('owner-a');
    expect(d.activity.count).toBe(2);
    await d.rpc('owner-a', '/api/x'); // 503 not active, still client activity
    expect(d.activity.count).toBe(3);

    await bookmarklet(d); // the hello counts at once; the first poll follows asynchronously
    expect(d.activity.count).toBeGreaterThanOrEqual(4);
    const deadline = Date.now() + 2000;
    while (d.activity.count < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(d.activity.count).toBeGreaterThanOrEqual(5);
  });
});

describe('queue hygiene', () => {
  it('withdraws a request that timed out while still queued, so it never reaches the bookmarklet late', async () => {
    const d = await daemon({ requestTimeoutMs: 100 });
    d.client.receiveHello('tok', TEST_REALM); // active, but nobody is polling yet

    const res = await d.rpc('owner-a', '/api/impersonation/realm/start', { method: 'POST', body: { qb_user_id: '1' } });
    const b = await bookmarklet(d); // the bookmarklet shows up after the caller gave up
    await new Promise((r) => setTimeout(r, 150));

    expect(res.statusCode).toBe(504);
    expect(b.seen).toEqual([]);
    expect(await httpReq('GET', d.port, '/relay/status')).toMatchObject({ body: { queued: 0, pending: 0 } });
  });

  it('forgets a dropped long-poll connection, so the next request waits for the next poll instead of being lost', async () => {
    const d = await daemon({ requestTimeoutMs: 3000 });
    const first = await bookmarklet(d);
    const registered = Date.now() + 2000;
    while (d.activity.count < 2 && Date.now() < registered) await new Promise((r) => setTimeout(r, 5)); // hello + long-poll registered
    expect(d.activity.count).toBeGreaterThanOrEqual(2);
    await first.stop(); // the tab is closed: its poll connection drops
    await new Promise((r) => setTimeout(r, 50));

    const pending = d.rpc('owner-a', '/api/after-drop'); // the relay still looks active (fresh hello)
    pending.catch(() => {}); // if an assertion below fails, the abandoned call must not crash the worker
    const deadline = Date.now() + 2000;
    while (d.client.pendingCount < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(d.client.pendingCount).toBe(1);
    expect(d.client.queuedCount).toBe(1); // waiting for a poll, not thrown at the dead connection

    const second = await bookmarklet(d); // a fresh tab polls
    const res = await pending;

    expect(res.body).toMatchObject({ ok: true });
    expect(second.seen.map((r) => r.path)).toEqual(['/api/after-drop']);
  });
});

describe('log hygiene', () => {
  it('logs method and path without the query string, redacts user look-ups, and never logs secrets, tokens or bodies', async () => {
    const d = await daemon();
    await bookmarklet(d, () => ({ status: 200, data: { secretResponse: 'SENTINEL-RESPONSE' } }));

    await d.rpc('owner-a', '/api/v2/pipelines/query/paged?pageNumber=1&searchString=SENTINEL-QUERY', {
      method: 'POST',
      body: { note: 'SENTINEL-BODY' },
    });
    await d.rpc('owner-a', '/api/realm/findmatchingusers/jane%40example.com');
    await d.call('/relay/rpc', { owner: 'owner-a', path: '/api/x', method: 'GET' }, { 'X-QB-Relay-Secret': 'cd'.repeat(32) });

    const log = d.logs.join('\n');
    expect(log).toContain('POST /api/v2/pipelines/query/paged');
    expect(log).toContain('/api/realm/findmatchingusers/<redacted>');
    for (const forbidden of [TEST_SECRET, 'cd'.repeat(32), 'fake-csrf-token', 'SENTINEL-QUERY', 'SENTINEL-BODY', 'SENTINEL-RESPONSE', 'jane', 'example.com']) {
      expect(log).not.toContain(forbidden);
    }
  });

  it('logs authentication failures without echoing what was sent', async () => {
    const d = await daemon();
    await d.call('/relay/rpc', { owner: 'owner-a', path: '/api/x', method: 'GET' }, { 'X-QB-Relay-Secret': 'wrong-secret-value' });

    const log = d.logs.join('\n');
    expect(log).toMatch(/401|unauthori[sz]ed|secret/i);
    expect(log).not.toContain('wrong-secret-value');
  });
});

describe('plain (non-daemon) mode', () => {
  it('has no control surface: /relay/info, /relay/rpc and /relay/stop do not exist', async () => {
    const port = await getFreePort();
    const server = startRelayServer(TEST_REALM, port, { log: () => {} });
    await server.ready;

    expect((await httpReq('GET', port, '/relay/info')).statusCode).toBe(404);
    expect((await httpReq('POST', port, '/relay/rpc', '{}')).statusCode).toBe(404);
    expect((await httpReq('POST', port, '/relay/stop', '{}')).statusCode).toBe(404);
    expect((await httpReq('GET', port, '/relay/status')).body).toEqual({ active: false, realmUser: null });
    await server.close();
  });
});
