import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { RelayClient, startRelayServer } from '../src/relay/server';
import { getFreePort, httpReq, httpReqFull } from './helpers/relayHarness';

// QB-47 hardening: relay path validation, Host (DNS rebinding), Origin and
// Fetch Metadata checks. Every server below binds an OS-assigned free port.

const REALM = 'test.quickbase.com';
const REALM_ORIGIN = `https://${REALM}`;
const FAKE_RESULT_ID = '00000000-0000-1000-8000-0000000000aa';
const HELLO_BODY = JSON.stringify({ csrfToken: 'tok', realm: REALM });

/** Starts a relay on a free port; `stop()` closes it. */
async function startRelay(): Promise<{ port: number; client: RelayClient; stop: () => Promise<void> }> {
  const port = await getFreePort();
  const server = startRelayServer(REALM, port, { log: () => {} });
  await server.ready;
  return { port, client: server.client, stop: () => server.close() };
}

describe('RelayClient — request() validation (in-process path)', () => {
  function activeClientWithPoll() {
    const client = new RelayClient(3799);
    client.receiveHello('csrf', REALM);
    const fakeRes = { writableEnded: false, on: jest.fn(), writeHead: jest.fn().mockReturnThis(), end: jest.fn() } as any;
    client.registerLongPoll(fakeRes);
    return { client, fakeRes };
  }

  it.each([
    'https://evil.example/steal',
    '//evil.example/api/x',
    '/api/../admin',
    '/api/%2e%2e/admin',
    '/api/x@evil.example',
    '/api/x＠evil.example',
    '/api/x\\y',
    'api/x',
  ])('rejects the path %j with InvalidParams and queues nothing', async (badPath) => {
    const { client, fakeRes } = activeClientWithPoll();

    await expect(client.request(badPath, 'GET')).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    expect(fakeRes.writeHead).not.toHaveBeenCalled();
    expect(fakeRes.end).not.toHaveBeenCalled();
  });

  it('validates before the not-active check, so a bad path is never reported as "relay not active"', async () => {
    const client = new RelayClient(3799); // no hello: relay inactive
    await expect(client.request('https://evil.example', 'GET')).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it('rejects a method outside the allowed set', async () => {
    const { client } = activeClientWithPoll();
    await expect(client.request('/api/x', 'TRACE')).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects a caller-supplied X-CSRFToken so it cannot override the bookmarklet token', async () => {
    const { client } = activeClientWithPoll();
    await expect(
      client.request('/api/x', 'GET', undefined, { 'X-CSRFToken': 'stolen' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});

describe('startRelayServer — Host header validation (DNS-rebinding defence)', () => {
  const endpoints: Array<[string, string, string | undefined]> = [
    ['GET', '/setup', undefined],
    ['GET', '/relay/status', undefined],
    ['GET', '/relay/pending', undefined],
    ['POST', '/relay/hello', HELLO_BODY],
    ['POST', `/relay/result/${FAKE_RESULT_ID}`, '{}'],
    ['POST', '/relay/shutdown', '{}'],
  ];

  it.each(endpoints)(
    '%s %s with a foreign Host header is refused with 403 and no CORS headers',
    async (method, url, body) => {
      const { port, stop } = await startRelay();

      const res = await httpReqFull(method, port, url, body, { Host: 'rebound.evil.example' });

      expect(res.statusCode).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await stop();
    },
  );

  it('a rebinding attempt cannot activate the relay', async () => {
    const { port, stop } = await startRelay();

    const hello = await httpReqFull('POST', port, '/relay/hello', HELLO_BODY, { Host: 'rebound.evil.example' });
    const status = await httpReq('GET', port, '/relay/status');

    expect(hello.statusCode).toBe(403);
    expect((status.body as any).active).toBe(false);
    await stop();
  });

  it.each(['localhost', 'LOCALHOST', '127.0.0.1'])('accepts the Host name %s with the correct port', async (name) => {
    const { port, stop } = await startRelay();

    const res = await httpReqFull('GET', port, '/relay/status', undefined, { Host: `${name}:${port}` });

    expect(res.statusCode).toBe(200);
    await stop();
  });

  it('refuses a legitimate host name with the wrong port', async () => {
    const { port, stop } = await startRelay();

    const res = await httpReqFull('GET', port, '/relay/status', undefined, { Host: 'localhost:1' });

    expect(res.statusCode).toBe(403);
    await stop();
  });
});

describe('startRelayServer — Origin validation on the bookmarklet endpoints', () => {
  it.each(['https://evil.example', '', 'null'])(
    'POST /relay/hello with Origin %j is refused and cannot activate the relay',
    async (origin) => {
      const { port, stop } = await startRelay();

      const res = await httpReqFull('POST', port, '/relay/hello', HELLO_BODY, { Origin: origin });
      const status = await httpReq('GET', port, '/relay/status');

      expect(res.statusCode).toBe(403);
      expect((status.body as any).active).toBe(false);
      await stop();
    },
  );

  it('POST /relay/hello from the QB realm origin is accepted and activates the relay', async () => {
    const { port, stop } = await startRelay();

    const res = await httpReqFull('POST', port, '/relay/hello', HELLO_BODY, { Origin: REALM_ORIGIN });
    const status = await httpReq('GET', port, '/relay/status');

    expect(res.statusCode).toBe(204);
    expect((status.body as any).active).toBe(true);
    await stop();
  });

  it('POST /relay/hello without an Origin header (same-process caller) is still accepted', async () => {
    const { port, stop } = await startRelay();

    const res = await httpReqFull('POST', port, '/relay/hello', HELLO_BODY);

    expect(res.statusCode).toBe(204);
    await stop();
  });

  it.each(['https://evil.example', '', 'null'])(
    'GET /relay/pending with Origin %j is refused and does not consume a queued request',
    async (origin) => {
      const { port, client, stop } = await startRelay();
      client.receiveHello('tok', REALM);
      const queued = client.request('/api/v2/pipelines/test', 'GET');

      const refused = await httpReqFull('GET', port, '/relay/pending', undefined, { Origin: origin });
      const legit = await httpReqFull('GET', port, '/relay/pending', undefined, { Origin: REALM_ORIGIN });

      expect(refused.statusCode).toBe(403);
      expect(legit.statusCode).toBe(200);
      expect(legit.body).toMatchObject({ path: '/api/v2/pipelines/test' });

      await httpReq('POST', port, `/relay/result/${(legit.body as any).id}`, JSON.stringify({ status: 200, data: {} }));
      await expect(queued).resolves.toEqual({ status: 200, data: {} });
      await stop();
    },
  );
});

describe('startRelayServer — Fetch Metadata (Sec-Fetch-Mode)', () => {
  it.each(['no-cors', 'navigate', 'websocket'])('POST /relay/hello with Sec-Fetch-Mode %s is refused', async (mode) => {
    const { port, stop } = await startRelay();

    const res = await httpReqFull('POST', port, '/relay/hello', HELLO_BODY, { 'Sec-Fetch-Mode': mode });

    expect(res.statusCode).toBe(403);
    await stop();
  });

  it('GET /relay/pending with Sec-Fetch-Mode no-cors is refused and leaves the request queued', async () => {
    const { port, client, stop } = await startRelay();
    client.receiveHello('tok', REALM);
    const queued = client.request('/api/v2/pipelines/test', 'GET');

    const refused = await httpReqFull('GET', port, '/relay/pending', undefined, { 'Sec-Fetch-Mode': 'no-cors' });
    const legit = await httpReqFull('GET', port, '/relay/pending', undefined, { 'Sec-Fetch-Mode': 'cors' });

    expect(refused.statusCode).toBe(403);
    expect(legit.statusCode).toBe(200);
    await httpReq('POST', port, `/relay/result/${(legit.body as any).id}`, JSON.stringify({ status: 200, data: {} }));
    await expect(queued).resolves.toEqual({ status: 200, data: {} });
    await stop();
  });

  it('POST /relay/result/:id with Sec-Fetch-Mode no-cors is refused', async () => {
    const { port, stop } = await startRelay();

    const res = await httpReqFull('POST', port, `/relay/result/${FAKE_RESULT_ID}`, '{}', {
      'Sec-Fetch-Mode': 'no-cors',
    });

    expect(res.statusCode).toBe(403);
    await stop();
  });

  it("accepts the bookmarklet's real request shape (CORS mode, QB realm origin)", async () => {
    const { port, stop } = await startRelay();

    const res = await httpReqFull('POST', port, '/relay/hello', HELLO_BODY, {
      Origin: REALM_ORIGIN,
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    });

    expect(res.statusCode).toBe(204);
    await stop();
  });

  it('does not apply to the human-facing pages: /setup (navigation) and /relay/status (same-origin fetch)', async () => {
    const { port, stop } = await startRelay();

    const setup = await httpReqFull('GET', port, '/setup', undefined, { 'Sec-Fetch-Mode': 'navigate' });
    const status = await httpReqFull('GET', port, '/relay/status', undefined, { 'Sec-Fetch-Mode': 'same-origin' });

    expect(setup.statusCode).toBe(200);
    expect(status.statusCode).toBe(200);
    await stop();
  });
});

describe('startRelayServer — bookmarklet payload shape', () => {
  it('POST /relay/result/:id with a body that is not a relay result is refused and resolves nothing', async () => {
    const { port, client, stop } = await startRelay();
    client.receiveHello('tok', REALM);
    const queued = client.request('/api/v2/pipelines/test', 'GET');
    const legit = await httpReqFull('GET', port, '/relay/pending', undefined, { Origin: REALM_ORIGIN });
    const id = (legit.body as any).id;

    for (const body of ['', 'null', '"text"', '{"data":1}', '{"status":"200"}']) {
      const res = await httpReqFull('POST', port, `/relay/result/${id}`, body, { Origin: REALM_ORIGIN });
      expect(res.statusCode).toBe(400);
    }
    await httpReq('POST', port, `/relay/result/${id}`, JSON.stringify({ status: 200, data: {} }));
    await expect(queued).resolves.toEqual({ status: 200, data: {} });
    await stop();
  });

  it('POST /relay/hello with a non-string realm or token does not activate the relay', async () => {
    const { port, client, stop } = await startRelay();

    await httpReqFull('POST', port, '/relay/hello', JSON.stringify({ csrfToken: 'tok', realm: { x: 1 } }), { Origin: REALM_ORIGIN });
    await httpReqFull('POST', port, '/relay/hello', JSON.stringify({ csrfToken: 5, realm: REALM }), { Origin: REALM_ORIGIN });

    expect(client.isActive).toBe(false);
    expect(client.currentUser).toBeNull();
    await stop();
  });
});
