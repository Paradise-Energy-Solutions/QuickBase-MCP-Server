import { RelayClient } from '../src/relay/server';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

// We test RelayClient in isolation — no actual HTTP server needed.

const TEST_PORT = 3737;

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
        expect(msg).toContain('logged in');
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
});
