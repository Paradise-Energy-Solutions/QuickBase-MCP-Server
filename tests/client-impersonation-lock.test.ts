/**
 * QuickBaseClient holds the shared relay's exclusive impersonation lock from the
 * moment an impersonation starts until it ends, so two MCP processes can never
 * interleave and run a call as the other's identity. These tests pin the order
 * of lock and relay calls with a recording transport.
 */
import { QuickBaseClient } from '../src/quickbase/client';
import { QuickBaseConfig } from '../src/types/quickbase';
import type { RelayTransport } from '../src/relay/types';
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

const START = '/api/impersonation/realm/start';
const END = '/api/impersonation/end';

/** An error shaped like the relay's RelayError (a `kind` on an Error). */
const relayFailure = (kind: string, message: string) => Object.assign(new Error(message), { kind });

interface Recorder {
  transport: RelayTransport;
  events: string[];
}

function makeRecorder(opts: {
  failPaths?: string[];
  acquire?: () => Promise<void>;
  release?: () => Promise<void>;
  withLockMethods?: boolean;
} = {}): Recorder {
  const events: string[] = [];
  const transport: RelayTransport = {
    isActive: true,
    currentUser: 'paradiseenergysolutions.quickbase.com',
    request: jest.fn(async (path: string) => {
      events.push(`request ${path}`);
      if (opts.failPaths?.some((p) => path.startsWith(p))) return { status: 500, data: { message: 'boom' } };
      return { status: 200, data: { ok: true } };
    }),
  };
  if (opts.withLockMethods !== false) {
    transport.acquireExclusive = jest.fn(async () => {
      events.push('acquire');
      await opts.acquire?.();
    });
    transport.releaseExclusive = jest.fn(async () => {
      events.push('release');
      await opts.release?.();
    });
  }
  return { transport, events };
}

function makeClient(recorder: Recorder): QuickBaseClient {
  mockedAxios.create.mockReturnValue({
    get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    defaults: { headers: { post: {}, put: {}, patch: {} } },
  } as any);
  const client = new QuickBaseClient(mockConfig);
  client.setRelayClient(recorder.transport);
  return client;
}

describe('scoped impersonation (impersonateUserId)', () => {
  it('holds the lock around the whole acquire -> start -> call -> end -> release sequence', async () => {
    const rec = makeRecorder();
    const client = makeClient(rec);

    await client.listPipelines({ impersonateUserId: '123' });

    expect(rec.events).toEqual([
      'acquire',
      `request ${START}`,
      'request /api/v2/pipelines/query/paged?pageNumber=1&pageSize=25',
      `request ${END}`,
      'release',
    ]);
  });

  it('does not touch the lock when no impersonation is requested', async () => {
    const rec = makeRecorder();
    const client = makeClient(rec);

    await client.listPipelines();

    expect(rec.transport.acquireExclusive).not.toHaveBeenCalled();
    expect(rec.transport.releaseExclusive).not.toHaveBeenCalled();
  });

  const scopedCalls: Array<[string, (c: QuickBaseClient) => Promise<unknown>]> = [
    ['getPipelineDetail', (c) => c.getPipelineDetail('9', '123')],
    ['getPipelineActivity', (c) => c.getPipelineActivity('9', { impersonateUserId: '123' })],
    ['getPipelineStepConfig', (c) => c.getPipelineStepConfig('9', '4', '123')],
    ['getPipelineYaml', (c) => c.getPipelineYaml('9', '123')],
    ['getPipelineTriggerSummary', (c) => c.getPipelineTriggerSummary('9', '123')],
    [
      'batchGetPipelineSteps (one lock hold for the whole batch)',
      (c) =>
        c.batchGetPipelineSteps(
          [
            { pipelineId: '9', stepId: '1' },
            { pipelineId: '9', stepId: '2' },
            { pipelineId: '9', stepId: '3' },
          ],
          '123',
        ),
    ],
  ];

  it.each(scopedCalls)('%s wraps its impersonation in exactly one lock hold', async (_name, call) => {
    const rec = makeRecorder();
    const client = makeClient(rec);

    await call(client);

    expect(rec.events[0]).toBe('acquire');
    expect(rec.events[1]).toBe(`request ${START}`);
    expect(rec.events[rec.events.length - 2]).toBe(`request ${END}`);
    expect(rec.events[rec.events.length - 1]).toBe('release');
    expect(rec.events.filter((e) => e === 'acquire')).toHaveLength(1);
    expect(rec.events.filter((e) => e === 'release')).toHaveLength(1);
  });

  it('releases the lock and makes no end request when the impersonation start fails', async () => {
    const rec = makeRecorder({ failPaths: [START] });
    const client = makeClient(rec);

    await expect(client.listPipelines({ impersonateUserId: '123' })).rejects.toThrow(/HTTP 500/);

    expect(rec.events).toEqual(['acquire', `request ${START}`, 'release']);
  });

  it('still ends the impersonation and releases the lock when the main call fails', async () => {
    const rec = makeRecorder({ failPaths: ['/api/v2/pipelines/query/paged'] });
    const client = makeClient(rec);

    await expect(client.listPipelines({ impersonateUserId: '123' })).rejects.toThrow(/HTTP 500/);

    expect(rec.events.slice(-2)).toEqual([`request ${END}`, 'release']);
  });

  it('keeps the lock when the end request fails (the browser may still be impersonating), and still returns the result', async () => {
    const rec = makeRecorder({ failPaths: [END] });
    const client = makeClient(rec);

    await expect(client.listPipelines({ impersonateUserId: '123' })).resolves.toBeDefined();

    expect(rec.events[rec.events.length - 1]).toBe(`request ${END}`);
    expect(rec.transport.releaseExclusive).not.toHaveBeenCalled();
  });

  it('fails without any relay call when the lock cannot be acquired (another session is impersonating)', async () => {
    const rec = makeRecorder({
      acquire: async () => {
        throw new Error('Another session is impersonating a user');
      },
    });
    const client = makeClient(rec);

    await expect(client.listPipelines({ impersonateUserId: '123' })).rejects.toThrow(/Another session/);

    expect(rec.events).toEqual(['acquire']);
    expect(rec.transport.request).not.toHaveBeenCalled();
    expect(rec.transport.releaseExclusive).not.toHaveBeenCalled();
  });

  it('does not let a failing release hide the result of a successful call', async () => {
    const rec = makeRecorder({
      release: async () => {
        throw new Error('daemon unreachable');
      },
    });
    const client = makeClient(rec);

    await expect(client.getPipelineDetail('9', '123')).resolves.toBeDefined();
  });
});

describe('explicit impersonation tools (start and end are separate tool calls)', () => {
  it('startPipelineImpersonation takes the lock and keeps it held', async () => {
    const rec = makeRecorder();
    const client = makeClient(rec);

    await client.startPipelineImpersonation('123');

    expect(rec.events).toEqual(['acquire', `request ${START}`]);
  });

  it('endPipelineImpersonation ends the impersonation, then releases the lock', async () => {
    const rec = makeRecorder();
    const client = makeClient(rec);

    await client.endPipelineImpersonation();

    expect(rec.events).toEqual([`request ${END}`, 'release']);
  });

  it('endPipelineImpersonation keeps the lock when the end request fails, so the daemon can end it on expiry', async () => {
    const rec = makeRecorder({ failPaths: [END] });
    const client = makeClient(rec);

    await expect(client.endPipelineImpersonation()).rejects.toThrow(/HTTP 500/);

    expect(rec.events).toEqual([`request ${END}`]);
  });

  it('a start that fails in transit is undone under the lock, and the lock is released only once that worked', async () => {
    const rec = makeRecorder();
    (rec.transport.request as jest.Mock).mockImplementationOnce(async (path: string) => {
      rec.events.push(`request ${path}`);
      throw relayFailure('unavailable', 'daemon stopped answering');
    });
    const client = makeClient(rec);

    await expect(client.startPipelineImpersonation('123')).rejects.toThrow(/stopped answering/);

    expect(rec.events).toEqual(['acquire', `request ${START}`, `request ${END}`, 'release']);
  });

  it('a start that fails in transit keeps the lock when the undo fails too', async () => {
    const rec = makeRecorder();
    (rec.transport.request as jest.Mock).mockImplementation(async (path: string) => {
      rec.events.push(`request ${path}`);
      throw relayFailure('unavailable', 'daemon stopped answering');
    });
    const client = makeClient(rec);

    await expect(client.startPipelineImpersonation('123')).rejects.toThrow(/stopped answering/);

    expect(rec.events).toEqual(['acquire', `request ${START}`, `request ${END}`]);
  });

  it('a start that fails in transit keeps the lock when the undo is answered with an HTTP error', async () => {
    const rec = makeRecorder({ failPaths: [END] });
    (rec.transport.request as jest.Mock).mockImplementationOnce(async (path: string) => {
      rec.events.push(`request ${path}`);
      throw relayFailure('unavailable', 'daemon stopped answering');
    });
    const client = makeClient(rec);

    await expect(client.startPipelineImpersonation('123')).rejects.toThrow(/stopped answering/);

    expect(rec.events).toEqual(['acquire', `request ${START}`, `request ${END}`]);
  });

  it('a start the relay never sent (not active) releases the lock without an undo request', async () => {
    const rec = makeRecorder();
    (rec.transport.request as jest.Mock).mockImplementation(async (path: string) => {
      rec.events.push(`request ${path}`);
      throw relayFailure('not_active', 'relay not active');
    });
    const client = makeClient(rec);

    await expect(client.startPipelineImpersonation('123')).rejects.toThrow(/not active/);

    expect(rec.events).toEqual(['acquire', `request ${START}`, 'release']);
  });
});

describe('transports without lock methods (test doubles, single-process use)', () => {
  it('keep working: impersonation proceeds without acquire or release', async () => {
    const rec = makeRecorder({ withLockMethods: false });
    const client = makeClient(rec);

    await client.listPipelines({ impersonateUserId: '123' });

    expect(rec.events).toEqual([
      `request ${START}`,
      'request /api/v2/pipelines/query/paged?pageNumber=1&pageSize=25',
      `request ${END}`,
    ]);
  });
});
