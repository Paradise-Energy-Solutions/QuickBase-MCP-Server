/**
 * Tests for QuickBaseClient pipeline methods.
 *
 * The pipeline methods delegate all HTTP work to a RelayClient. We inject a
 * jest mock relay so these tests exercise the client logic (URL construction,
 * impersonation wrapping, error handling) without requiring a real browser.
 */
import { QuickBaseClient } from '../src/quickbase/client';
import { QuickBaseConfig } from '../src/types/quickbase';
import { RelayClient } from '../src/relay/server';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockConfig: QuickBaseConfig = {
  realm: 'paradiseenergysolutions.quickbase.com',
  userToken: 'token123',
  appId: 'brcf2n7tq',
  timeout: 30000,
  maxRetries: 3,
};

// Minimal RelayClient mock — only `request` is called by the client methods.
function makeMockRelay(
  responseMap: Record<string, unknown> = {}
): jest.Mocked<Pick<RelayClient, 'request'>> & RelayClient {
  const relay = {
    request: jest.fn().mockImplementation(async (path: string) => {
      const data = responseMap[path] ?? { ok: true };
      return { status: 200, data };
    }),
  } as unknown as jest.Mocked<Pick<RelayClient, 'request'>> & RelayClient;
  return relay;
}

function makeClient(relay?: ReturnType<typeof makeMockRelay>): {
  client: QuickBaseClient;
  relay: ReturnType<typeof makeMockRelay>;
} {
  const mockAxiosInstance = {
    get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
    defaults: { headers: { post: {}, put: {}, patch: {} } },
  };
  mockedAxios.create.mockReturnValue(mockAxiosInstance as any);

  const client = new QuickBaseClient(mockConfig);
  const r = relay ?? makeMockRelay();
  client.setRelayClient(r as unknown as RelayClient);
  return { client, relay: r };
}

// ─── requireRelay ────────────────────────────────────────────────────────────

describe('requireRelay', () => {
  it('throws a plain Error if no relay has been injected', async () => {
    const mockAxiosInstance = {
      get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(),
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      defaults: { headers: { post: {}, put: {}, patch: {} } },
    };
    mockedAxios.create.mockReturnValue(mockAxiosInstance as any);
    const client = new QuickBaseClient(mockConfig);
    await expect(client.listPipelines()).rejects.toThrow('Pipeline relay client is not configured');
  });
});

// ─── unwrapRelayResult ────────────────────────────────────────────────────────

describe('unwrapRelayResult (via listPipelines)', () => {
  it('throws McpError when relay returns status 401', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 401, data: { message: 'Unauthorized' } });
    const { client } = makeClient(relay);
    await expect(client.listPipelines()).rejects.toBeInstanceOf(McpError);
  });

  it('throws McpError when relay returns status 0 (network error)', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 0, data: null, error: 'fetch failed' });
    const { client } = makeClient(relay);
    await expect(client.listPipelines()).rejects.toBeInstanceOf(McpError);
  });

  it('throws McpError with status code in message', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 500, data: { error: 'server error' } });
    const { client } = makeClient(relay);
    await expect(client.listPipelines()).rejects.toMatchObject({
      message: expect.stringContaining('500'),
    });
  });

  it('returns data on status 200', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 200, data: { pipelines: [{ id: 1, name: 'P' }] } });
    const { client } = makeClient(relay);
    const result = await client.listPipelines();
    expect(result).toEqual({ pipelines: [{ id: 1, name: 'P' }] });
  });
});

// ─── listPipelines ────────────────────────────────────────────────────────────

describe('listPipelines', () => {
  it('calls paged endpoint with defaults', async () => {
    const { client, relay } = makeClient();
    await client.listPipelines();

    expect(relay.request).toHaveBeenCalledWith(
      expect.stringContaining('/api/v2/pipelines/query/paged'),
      'POST',
      expect.objectContaining({ requestRealmPipelines: false })
    );
    const [path] = relay.request.mock.calls[0];
    expect(path).toContain('pageNumber=1');
    expect(path).toContain('pageSize=25');
  });

  it('passes realmWide=true when requested', async () => {
    const { client, relay } = makeClient();
    await client.listPipelines({ realmWide: true });
    expect(relay.request).toHaveBeenCalledWith(
      expect.any(String),
      'POST',
      expect.objectContaining({ requestRealmPipelines: true })
    );
  });

  it('honours custom pageNumber and pageSize', async () => {
    const { client, relay } = makeClient();
    await client.listPipelines({ pageNumber: 3, pageSize: 50 });
    const [path] = relay.request.mock.calls[0];
    expect(path).toContain('pageNumber=3');
    expect(path).toContain('pageSize=50');
  });

  it('wraps with impersonation when impersonateUserId provided', async () => {
    const relay = makeMockRelay();
    // Resolve in order: startImpersonation, listPipelines, endImpersonation
    relay.request
      .mockResolvedValueOnce({ status: 200, data: { started: true } })  // start
      .mockResolvedValueOnce({ status: 200, data: { pipelines: [] } })  // list
      .mockResolvedValueOnce({ status: 200, data: { ended: true } });   // end
    const { client } = makeClient(relay);

    await client.listPipelines({ impersonateUserId: '62913114' });

    expect(relay.request).toHaveBeenCalledTimes(3);
    expect(relay.request.mock.calls[0][0]).toBe('/api/impersonation/realm/start');
    expect(relay.request.mock.calls[0][2]).toEqual({ qb_user_id: '62913114' });
    expect(relay.request.mock.calls[2][0]).toBe('/api/impersonation/end');
  });

  it('always ends impersonation even when the list request fails', async () => {
    const relay = makeMockRelay();
    relay.request
      .mockResolvedValueOnce({ status: 200, data: {} })  // start
      .mockResolvedValueOnce({ status: 500, data: 'error' })  // list — throws
      .mockResolvedValueOnce({ status: 200, data: {} });  // end
    const { client } = makeClient(relay);

    await expect(
      client.listPipelines({ impersonateUserId: '62913114' })
    ).rejects.toBeInstanceOf(McpError);

    // endPipelineImpersonation must have been called regardless
    expect(relay.request).toHaveBeenCalledTimes(3);
    expect(relay.request.mock.calls[2][0]).toBe('/api/impersonation/end');
  });
});

// ─── getPipelineDetail ────────────────────────────────────────────────────────

describe('getPipelineDetail', () => {
  it('calls the designer endpoint for the given pipelineId', async () => {
    const { client, relay } = makeClient();
    await client.getPipelineDetail('6721062615859200');
    expect(relay.request).toHaveBeenCalledWith(
      '/api/v2/pipelines/6721062615859200/designer?open=true',
      'GET'
    );
  });

  it('URL-encodes the pipeline ID', async () => {
    const { client, relay } = makeClient();
    await client.getPipelineDetail('abc/def');
    const [path] = relay.request.mock.calls[0];
    expect(path).toContain('abc%2Fdef');
    expect(path).not.toContain('abc/def/designer');
  });

  it('wraps with impersonation when impersonateUserId provided', async () => {
    const relay = makeMockRelay();
    relay.request
      .mockResolvedValueOnce({ status: 200, data: {} })  // start
      .mockResolvedValueOnce({ status: 200, data: { id: 123 } })  // get
      .mockResolvedValueOnce({ status: 200, data: {} });  // end
    const { client } = makeClient(relay);
    await client.getPipelineDetail('123', '62913114');
    expect(relay.request.mock.calls[0][0]).toBe('/api/impersonation/realm/start');
    expect(relay.request.mock.calls[2][0]).toBe('/api/impersonation/end');
  });
});

// ─── getPipelineActivity ──────────────────────────────────────────────────────

describe('getPipelineActivity', () => {
  it('builds query string with pipeline_id and per_page', async () => {
    const { client, relay } = makeClient();
    await client.getPipelineActivity('9876', { perPage: 10 });
    const [path] = relay.request.mock.calls[0];
    expect(path).toContain('pipeline_id=9876');
    expect(path).toContain('per_page=10');
  });

  it('includes all three scope values', async () => {
    const { client, relay } = makeClient();
    await client.getPipelineActivity('1');
    const [path] = relay.request.mock.calls[0];
    // URLSearchParams append() produces scope=pipe&scope=poller&scope=pipeline
    expect(path).toMatch(/scope=pipe/);
    expect(path).toMatch(/scope=poller/);
    expect(path).toMatch(/scope=pipeline/);
  });

  it('uses provided startDate and endDate when given', async () => {
    const { client, relay } = makeClient();
    const start = '2026-01-01T00:00:00Z';
    const end = '2026-05-01T00:00:00Z';
    await client.getPipelineActivity('1', { startDate: start, endDate: end });
    const [path] = relay.request.mock.calls[0];
    const startUnix = Math.floor(new Date(start).getTime() / 1000);
    const endUnix = Math.floor(new Date(end).getTime() / 1000);
    expect(path).toContain(`start=${startUnix}`);
    expect(path).toContain(`end=${endUnix}`);
  });

  it('defaults to last 7 days when no dates given', async () => {
    const { client, relay } = makeClient();
    const before = Math.floor(Date.now() / 1000);
    await client.getPipelineActivity('1');
    const after = Math.floor(Date.now() / 1000);
    const [path] = relay.request.mock.calls[0];
    const endMatch = path.match(/end=(\d+)/);
    const startMatch = path.match(/start=(\d+)/);
    expect(endMatch).not.toBeNull();
    expect(startMatch).not.toBeNull();
    const endTs = parseInt(endMatch![1], 10);
    const startTs = parseInt(startMatch![1], 10);
    expect(endTs).toBeGreaterThanOrEqual(before);
    expect(endTs).toBeLessThanOrEqual(after);
    expect(endTs - startTs).toBeCloseTo(7 * 86400, -1);  // within ±10s
  });
});

// ─── findPipelineUsers ────────────────────────────────────────────────────────

describe('findPipelineUsers', () => {
  it('calls the findmatchingusers endpoint', async () => {
    const { client, relay } = makeClient();
    await client.findPipelineUsers('cmartin');
    expect(relay.request).toHaveBeenCalledWith(
      '/api/realm/findmatchingusers/cmartin',
      'GET'
    );
  });

  it('URL-encodes special characters in the query', async () => {
    const { client, relay } = makeClient();
    await client.findPipelineUsers('John Doe');
    const [path] = relay.request.mock.calls[0];
    expect(path).toContain('John%20Doe');
  });
});

// ─── startPipelineImpersonation ───────────────────────────────────────────────

describe('startPipelineImpersonation', () => {
  it('POSTs to the impersonation start endpoint with qb_user_id', async () => {
    const { client, relay } = makeClient();
    await client.startPipelineImpersonation('62913114');
    expect(relay.request).toHaveBeenCalledWith(
      '/api/impersonation/realm/start',
      'POST',
      { qb_user_id: '62913114' }
    );
  });

  it('returns the response data', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 200, data: { active: true, user: 'cmartin' } });
    const { client } = makeClient(relay);
    const result = await client.startPipelineImpersonation('62913114');
    expect(result).toEqual({ active: true, user: 'cmartin' });
  });
});

// ─── endPipelineImpersonation ─────────────────────────────────────────────────

describe('endPipelineImpersonation', () => {
  it('POSTs to the impersonation end endpoint', async () => {
    const { client, relay } = makeClient();
    await client.endPipelineImpersonation();
    expect(relay.request).toHaveBeenCalledWith(
      '/api/impersonation/end',
      'POST',
      {}
    );
  });

  it('returns the response data', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 200, data: { ended: true } });
    const { client } = makeClient(relay);
    const result = await client.endPipelineImpersonation();
    expect(result).toEqual({ ended: true });
  });
});

// ─── listPipelines channels/tags filter ───────────────────────────────────────

describe('listPipelines channel and tag filters', () => {
  it('passes channels array to the request body', async () => {
    const { client, relay } = makeClient();
    await client.listPipelines({ channels: ['webhooks'] });
    expect(relay.request).toHaveBeenCalledWith(
      expect.any(String),
      'POST',
      expect.objectContaining({ channels: ['webhooks'] })
    );
  });

  it('passes tags array to the request body', async () => {
    const { client, relay } = makeClient();
    await client.listPipelines({ tags: ['production'] });
    expect(relay.request).toHaveBeenCalledWith(
      expect.any(String),
      'POST',
      expect.objectContaining({ tags: ['production'] })
    );
  });

  it('defaults channels and tags to empty arrays when omitted', async () => {
    const { client, relay } = makeClient();
    await client.listPipelines();
    expect(relay.request).toHaveBeenCalledWith(
      expect.any(String),
      'POST',
      expect.objectContaining({ channels: [], tags: [] })
    );
  });
});

// ─── unwrapRelayResult 403 ───────────────────────────────────────────────────

describe('unwrapRelayResult 403 handling', () => {
  it('throws McpError with impersonation hint on 403', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 403, data: { message: 'Forbidden' } });
    const { client } = makeClient(relay);
    await expect(client.listPipelines()).rejects.toMatchObject({
      message: expect.stringMatching(/403 Forbidden/i),
    });
  });

  it('403 error message mentions impersonateUserId', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 403, data: null });
    const { client } = makeClient(relay);
    await expect(client.listPipelines()).rejects.toMatchObject({
      message: expect.stringContaining('impersonateUserId'),
    });
  });
});

// ─── getPipelineActivity empty-result annotation ──────────────────────────────

describe('getPipelineActivity empty-result annotation', () => {
  it('adds _note when items array is empty', async () => {
    const { client, relay } = makeClient();
    relay.request.mockResolvedValueOnce({ status: 200, data: { items: [], total: 0 } });
    const result: any = await client.getPipelineActivity('1');
    expect(result._note).toMatch(/No activity found/i);
    expect(result.items).toEqual([]);
  });

  it('does NOT add _note when items are present', async () => {
    const { client, relay } = makeClient();
    relay.request.mockResolvedValueOnce({ status: 200, data: { items: [{ id: 'run1' }], total: 1 } });
    const result: any = await client.getPipelineActivity('1');
    expect(result._note).toBeUndefined();
  });
});

// ─── getPipelineStepConfig ────────────────────────────────────────────────────

describe('getPipelineStepConfig', () => {
  it('calls the step endpoint with pipelineId and stepId URL-encoded', async () => {
    const { client, relay } = makeClient();
    await client.getPipelineStepConfig('6721062615859200', 'node_abc123');
    expect(relay.request).toHaveBeenCalledWith(
      '/api/v2/pipelines/6721062615859200/steps/node_abc123',
      'GET'
    );
  });

  it('URL-encodes special characters in both IDs', async () => {
    const { client, relay } = makeClient();
    await client.getPipelineStepConfig('abc/def', 'step/xyz');
    const [path] = relay.request.mock.calls[0];
    expect(path).toContain('abc%2Fdef');
    expect(path).toContain('step%2Fxyz');
  });

  it('wraps with impersonation when impersonateUserId provided', async () => {
    const relay = makeMockRelay();
    relay.request
      .mockResolvedValueOnce({ status: 200, data: {} })          // start
      .mockResolvedValueOnce({ status: 200, data: { step: 1 } }) // step fetch
      .mockResolvedValueOnce({ status: 200, data: {} });          // end
    const { client } = makeClient(relay);
    await client.getPipelineStepConfig('123', 'step1', '62913114');
    expect(relay.request.mock.calls[0][0]).toBe('/api/impersonation/realm/start');
    expect(relay.request.mock.calls[2][0]).toBe('/api/impersonation/end');
  });

  it('returns step data on success', async () => {
    const relay = makeMockRelay();
    const stepData = { id: 'node_abc', channel: 'webhooks', config: { url: 'https://example.com', method: 'POST' } };
    relay.request.mockResolvedValueOnce({ status: 200, data: stepData });
    const { client } = makeClient(relay);
    const result = await client.getPipelineStepConfig('1', 'node_abc');
    expect(result).toEqual(stepData);
  });

  it('throws McpError on 404', async () => {
    const relay = makeMockRelay();
    relay.request.mockResolvedValueOnce({ status: 404, data: { error: 'not found' } });
    const { client } = makeClient(relay);
    await expect(client.getPipelineStepConfig('1', 'bad_id')).rejects.toBeInstanceOf(McpError);
  });

  it('always ends impersonation even when the step request fails', async () => {
    const relay = makeMockRelay();
    relay.request
      .mockResolvedValueOnce({ status: 200, data: {} })   // start
      .mockResolvedValueOnce({ status: 500, data: 'error' }) // step fetch — throws
      .mockResolvedValueOnce({ status: 200, data: {} });   // end
    const { client } = makeClient(relay);

    await expect(
      client.getPipelineStepConfig('123', 'step1', '62913114')
    ).rejects.toBeInstanceOf(McpError);

    // endPipelineImpersonation must be called regardless of step fetch failure
    expect(relay.request).toHaveBeenCalledTimes(3);
    expect(relay.request.mock.calls[2][0]).toBe('/api/impersonation/end');
  });
});
