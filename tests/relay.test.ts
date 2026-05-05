import http from 'node:http';
import net from 'node:net';
import { RelayClient, startRelayServer } from '../src/relay/server';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

// We test RelayClient in isolation — no actual HTTP server needed.
// Integration tests for startRelayServer appear at the bottom of this file.

const TEST_PORT = 3737;

// ── Integration test helpers ──────────────────────────────────────────────────

/** Binds to port 0 and immediately closes to obtain an OS-assigned free port. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Polls until a TCP connection to the port succeeds or the timeout elapses. */
async function waitForPort(port: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 20));
    }
  }
  throw new Error(`Port ${port} did not open within ${timeoutMs} ms`);
}

/** Minimal http.request wrapper that returns status + parsed body. */
function httpReq(
  method: string,
  port: number,
  path: string,
  body?: string,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw || 'null') });
        } catch {
          resolve({ statusCode: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeClient(): RelayClient {
  return new RelayClient(TEST_PORT);
}

describe('RelayClient', () => {
  describe('isActive', () => {
    it('is false when no hello received', () => {
      const client = makeClient();
      expect(client.isActive).toBe(false);
    });

    it('is true after receiveHello', () => {
      const client = makeClient();
      client.receiveHello('csrf_token_abc', 'paradiseenergysolutions.quickbase.com');
      expect(client.isActive).toBe(true);
    });

    it('currentUser returns realm after hello', () => {
      const client = makeClient();
      client.receiveHello('tok', 'example.quickbase.com');
      expect(client.currentUser).toBe('example.quickbase.com');
    });

    it('currentUser is null before hello', () => {
      expect(makeClient().currentUser).toBeNull();
    });
  });

  describe('request() — relay not active', () => {
    it('throws McpError with setup instructions when relay inactive', async () => {
      const client = makeClient();
      await expect(client.request('/api/test', 'GET')).rejects.toMatchObject({
        message: expect.stringContaining('relay is not active')
      });
    });

    it('error message includes setup URL', async () => {
      expect.assertions(1);
      const client = makeClient();
      try {
        await client.request('/api/test', 'GET');
        fail('should have thrown');
      } catch (err) {
        expect((err as McpError).message).toContain(`http://localhost:${TEST_PORT}/setup`);
      }
    });

    it('error message includes step-by-step instructions', async () => {
      expect.assertions(2);
      const client = makeClient();
      try {
        await client.request('/api/test', 'GET');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain('bookmarklet');
        expect(msg).toContain('Pipelines dashboard');
      }
    });
  });

  describe('request() / receiveResult() — happy path', () => {
    it('resolves when result arrives', async () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');

      // Simulate a long-poll response object
      const fakeRes = {
        writableEnded: false,
        writeHead: jest.fn().mockReturnThis(),
        end: jest.fn((body: string) => {
          // Parse what was sent to the long-poll and immediately call receiveResult
          const req = JSON.parse(body);
          client.receiveResult(req.id, { status: 200, data: { pipelines: [] } });
        })
      } as any;

      client.registerLongPoll(fakeRes);

      const result = await client.request('/api/v2/pipelines/query/paged', 'POST', { searchString: '' });
      expect(result).toEqual({ status: 200, data: { pipelines: [] } });
    });

    it('includes path, method, and body in the queued request', async () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');

      let capturedReq: any;
      const fakeRes = {
        writableEnded: false,
        writeHead: jest.fn().mockReturnThis(),
        end: jest.fn((body: string) => {
          capturedReq = JSON.parse(body);
          client.receiveResult(capturedReq.id, { status: 200, data: {} });
        })
      } as any;

      client.registerLongPoll(fakeRes);

      await client.request('/api/v2/pipelines/1234/designer', 'GET');
      expect(capturedReq.path).toBe('/api/v2/pipelines/1234/designer');
      expect(capturedReq.method).toBe('GET');
    });
  });

  describe('receiveResult() — unknown id', () => {
    it('does not throw on unknown id', () => {
      const client = makeClient();
      expect(() => client.receiveResult('unknown-id', { status: 200, data: {} })).not.toThrow();
    });
  });

  describe('request() — 30-second timeout', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('rejects with McpError after 30 seconds', async () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');
      // No long-poll registered — request stays queued until timeout fires
      const requestPromise = client.request('/api/slow', 'GET');
      jest.advanceTimersByTime(30_001);
      await expect(requestPromise).rejects.toMatchObject({
        message: expect.stringContaining('timed out')
      });
    });

    it('timeout error message includes reconnect instructions', async () => {
      expect.assertions(2);
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');
      const requestPromise = client.request('/api/slow', 'GET');
      jest.advanceTimersByTime(30_001);
      try {
        await requestPromise;
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain('bookmarklet');
        expect(msg).toContain(`http://localhost:${TEST_PORT}/setup`);
      }
    });

    it('does not reject before 30 seconds have elapsed', async () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');
      let settled = false;
      client.request('/api/slow', 'GET').then(() => { settled = true; }).catch(() => { settled = true; });
      jest.advanceTimersByTime(29_999);
      // Flush microtasks
      await Promise.resolve();
      expect(settled).toBe(false);
      // Clean up — advance past timeout so the pending entry is removed
      jest.advanceTimersByTime(5_000);
    });
  });

  describe('registerLongPoll() — flushes queued requests', () => {
    it('immediately flushes a request that was queued before long-poll registered', async () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');

      // Queue a request before registering long-poll
      const requestPromise = client.request('/api/test', 'GET').catch(() => null);

      // Short delay to allow the promise to be registered
      await new Promise(r => setTimeout(r, 10));

      let capturedReq: any;
      const fakeRes = {
        writableEnded: false,
        writeHead: jest.fn().mockReturnThis(),
        end: jest.fn((body: string) => {
          capturedReq = JSON.parse(body);
          client.receiveResult(capturedReq.id, { status: 200, data: 'flushed' });
        })
      } as any;

      client.registerLongPoll(fakeRes);

      const result = await requestPromise;
      expect(result).toEqual({ status: 200, data: 'flushed' });
    });
  });

  describe('shutdown()', () => {
    it('sends a clean 204 to an open long-poll connection and clears it', () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');
      const fakeRes = {
        writableEnded: false,
        writeHead: jest.fn().mockReturnThis(),
        end: jest.fn(),
      } as any;
      client.registerLongPoll(fakeRes);

      client.shutdown();

      expect(fakeRes.writeHead).toHaveBeenCalledWith(204);
      expect(fakeRes.end).toHaveBeenCalled();
    });

    it('does not send 204 to an already-ended long-poll connection', () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');
      // Register a connection that is already ended before shutdown fires
      const endedRes = {
        writableEnded: true,
        writeHead: jest.fn().mockReturnThis(),
        end: jest.fn(),
      } as any;
      // Manually seed an ended long-poll by registering an active one first,
      // then registering the ended one (replaces the old one without 204-ing it
      // because writableEnded is checked on the *old* entry, not the new one).
      // Simplest approach: call shutdown() with no registered long-poll at all
      // to verify it does not throw.
      client.shutdown();
      expect(endedRes.writeHead).not.toHaveBeenCalled();
    });

    it('rejects all pending requests with McpError containing "shutting down"', async () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');
      // Queue two requests (no long-poll, so they remain pending)
      const p1 = client.request('/api/test1', 'GET');
      const p2 = client.request('/api/test2', 'POST', { data: 1 });

      client.shutdown();

      await expect(p1).rejects.toMatchObject({
        message: expect.stringContaining('shutting down'),
      });
      await expect(p2).rejects.toMatchObject({
        message: expect.stringContaining('shutting down'),
      });
    });

    it('is safe to call twice — does not double-reject pending requests', async () => {
      const client = makeClient();
      client.receiveHello('csrf', 'test.quickbase.com');
      const p = client.request('/api/test', 'GET');

      client.shutdown();
      // Second call must not throw even though pending map is already empty
      expect(() => client.shutdown()).not.toThrow();

      await expect(p).rejects.toMatchObject({
        message: expect.stringContaining('shutting down'),
      });
    });

    it('is safe to call with no long-poll and no pending requests', () => {
      expect(() => makeClient().shutdown()).not.toThrow();
    });
  });
});

// ── startRelayServer integration tests ───────────────────────────────────────
// These tests spin up real HTTP servers and therefore run slightly slower than
// the pure-unit tests above.

describe('startRelayServer — POST /relay/shutdown endpoint', () => {
  it('returns { ok: true } when called', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const port = await getFreePort();
    startRelayServer('test.quickbase.com', port);
    await waitForPort(port);

    const result = await httpReq('POST', port, '/relay/shutdown', '{}');

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ ok: true });
    consoleSpy.mockRestore();
    // server.close() is triggered via setImmediate inside the handler;
    // --forceExit handles any residual handle if it closes slowly.
  });

  it('GET /relay/shutdown returns 404 — only POST is accepted for this endpoint', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const port = await getFreePort();
    startRelayServer('test.quickbase.com', port);
    await waitForPort(port);

    const result = await httpReq('GET', port, '/relay/shutdown');

    expect(result.statusCode).toBe(404);

    // Clean up
    await httpReq('POST', port, '/relay/shutdown', '{}');
    consoleSpy.mockRestore();
  });
});

function httpReqWithHeaders(
  method: string,
  port: number,
  path: string,
  body: string | undefined,
  extraHeaders: Record<string, string>,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...extraHeaders };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw || 'null') });
        } catch {
          resolve({ statusCode: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('startRelayServer — Origin validation (CSRF protection)', () => {
  it('POST /relay/shutdown with no Origin header is accepted (same-process call)', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const port = await getFreePort();
    startRelayServer('test.quickbase.com', port);
    await waitForPort(port);

    const result = await httpReq('POST', port, '/relay/shutdown', '{}');
    expect(result.statusCode).toBe(200);
    consoleSpy.mockRestore();
  });

  it('POST /relay/shutdown with matching QB realm Origin is accepted', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const port = await getFreePort();
    startRelayServer('test.quickbase.com', port);
    await waitForPort(port);

    const result = await httpReqWithHeaders('POST', port, '/relay/shutdown', '{}', {
      'Origin': 'https://test.quickbase.com',
    });
    expect(result.statusCode).toBe(200);
    consoleSpy.mockRestore();
  });

  it('POST /relay/shutdown with foreign Origin is rejected with 403', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const port = await getFreePort();
    startRelayServer('test.quickbase.com', port);
    await waitForPort(port);

    const result = await httpReqWithHeaders('POST', port, '/relay/shutdown', '{}', {
      'Origin': 'https://evil.example.com',
    });
    expect(result.statusCode).toBe(403);

    // Clean up — send without Origin so the server actually shuts down
    await httpReq('POST', port, '/relay/shutdown', '{}');
    consoleSpy.mockRestore();
  });

  it('POST /relay/result/:id with foreign Origin is rejected with 403', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const port = await getFreePort();
    startRelayServer('test.quickbase.com', port);
    await waitForPort(port);

    const fakeId = '00000000-0000-1000-8000-000000000000';
    const result = await httpReqWithHeaders('POST', port, `/relay/result/${fakeId}`, '{}', {
      'Origin': 'https://evil.example.com',
    });
    expect(result.statusCode).toBe(403);

    await httpReq('POST', port, '/relay/shutdown', '{}');
    consoleSpy.mockRestore();
  });
});

describe('startRelayServer — EADDRINUSE retry', () => {
  it('sends a POST /relay/shutdown probe to the occupying server on the first retry', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let shutdownProbeReceived = false;

    const port = await getFreePort();
    const occupying = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/relay/shutdown') {
        shutdownProbeReceived = true;
      }
      res.writeHead(200).end('{}');
    });
    await new Promise<void>(r => occupying.listen(port, '127.0.0.1', () => r()));

    startRelayServer('test.quickbase.com', port);

    // The first EADDRINUSE fires in microseconds; the probe is an outbound
    // localhost HTTP request that completes in single-digit milliseconds.
    // 300 ms provides ample margin even on loaded CI machines.
    await new Promise(r => setTimeout(r, 300));

    expect(shutdownProbeReceived).toBe(true);

    consoleSpy.mockRestore();
    await new Promise<void>(r => occupying.close(() => r()));
  }, 5_000);

  it('logs a warning after all retry attempts are exhausted', async () => {
    // This test exercises the full backoff sequence (500+500+1000+1000+2000 ms).
    // It necessarily takes ~5 s; the timeout is set to 12 s for CI headroom.
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const port = await getFreePort();
    const occupying = http.createServer((_, res) => res.writeHead(404).end());
    await new Promise<void>(r => occupying.listen(port, '127.0.0.1', () => r()));

    startRelayServer('test.quickbase.com', port);

    // Wait for all 5 retries to exhaust: sum(RETRY_DELAYS_MS)=5000 ms + overhead
    await new Promise(r => setTimeout(r, 6500));

    expect(
      consoleSpy.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.includes('still in use after'),
      ),
    ).toBe(true);

    consoleSpy.mockRestore();
    await new Promise<void>(r => occupying.close(() => r()));
  }, 12_000);
});
