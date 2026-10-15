/**
 * Test harness for the shared relay daemon: an in-process daemon on a free port
 * (never the live relay port) and a FakeBookmarklet that behaves like the real
 * one on the wire (hello, long-poll /relay/pending, POST /relay/result/:id with
 * the headers a browser would send from the QuickBase origin).
 */

import http from 'node:http';
import { RelayClient, startRelayServer } from '../../src/relay/server';
import type { RelayServer } from '../../src/relay/server';
import type { RelayInfo, RelayRequest, RelayResult } from '../../src/relay/types';
import { FullResponse, getFreePort, httpReqFull, waitForPort } from './relayHarness';

export const TEST_REALM = 'test.quickbase.com';
export const TEST_ORIGIN = `https://${TEST_REALM}`;
export const TEST_SECRET = 'ab'.repeat(32);

export function makeTestInfo(overrides: Partial<RelayInfo> = {}): RelayInfo {
  return {
    protocolVersion: 1,
    buildVersion: '1.0.0+test0001',
    buildTime: '2026-10-15T00:00:00.000Z',
    pid: 4242,
    startedAt: '2026-10-15T00:00:00.000Z',
    realm: TEST_REALM,
    ...overrides,
  };
}

export interface TestDaemonOptions {
  /** Reuse a specific port (to model a daemon restarting on the same port). */
  port?: number;
  lockTtlMs?: number;
  lockWaitMs?: number;
  requestTimeoutMs?: number;
  info?: Partial<RelayInfo>;
  secret?: string;
  /** Close the server when /relay/stop is accepted, like the real daemon does. */
  closeOnStop?: boolean;
}

export interface TestDaemon {
  port: number;
  server: RelayServer;
  client: RelayClient;
  secret: string;
  /** Every line the daemon logged. */
  logs: string[];
  /** Reasons passed to the daemon's onStop callback. */
  stopReasons: string[];
  /** How many times the daemon's onActivity hook fired. */
  activity: { count: number };
  authHeaders: Record<string, string>;
  close(): Promise<void>;
  /** POST JSON to a control endpoint. Sends exactly the headers given: no secret is added. */
  call(path: string, body?: unknown, headers?: Record<string, string>): Promise<FullResponse>;
  /** POST /relay/rpc with the secret. */
  rpc(owner: string, path: string, extra?: Record<string, unknown>, headers?: Record<string, string>): Promise<FullResponse>;
  lockAcquire(owner: string, waitMs?: number): Promise<FullResponse>;
  lockRelease(owner: string): Promise<FullResponse>;
}

export async function startTestDaemon(opts: TestDaemonOptions = {}): Promise<TestDaemon> {
  const port = opts.port ?? (await getFreePort());
  const secret = opts.secret ?? TEST_SECRET;
  const logs: string[] = [];
  const stopReasons: string[] = [];
  const activity = { count: 0 };

  const server = startRelayServer(TEST_REALM, port, {
    requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
    log: (line) => logs.push(line),
    onActivity: () => {
      activity.count++;
    },
    control: {
      secret,
      info: makeTestInfo({ ...opts.info }),
      lockTtlMs: opts.lockTtlMs ?? 60_000,
      lockWaitMs: opts.lockWaitMs ?? 250,
      onStop: (reason) => {
        stopReasons.push(reason);
        if (opts.closeOnStop) void server.close();
      },
    },
  });
  await server.ready;
  await waitForPort(port);

  const authHeaders = { 'X-QB-Relay-Secret': secret };
  const call = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    httpReqFull('POST', port, path, JSON.stringify(body), headers);

  return {
    port,
    server,
    client: server.client,
    secret,
    logs,
    stopReasons,
    activity,
    authHeaders,
    close: () => server.close(),
    call,
    rpc: (owner, path, extra = {}, headers = authHeaders) =>
      call('/relay/rpc', { owner, path, method: 'GET', ...extra }, headers),
    lockAcquire: (owner, waitMs) => call('/relay/lock/acquire', { owner, waitMs }, authHeaders),
    lockRelease: (owner) => call('/relay/lock/release', { owner }, authHeaders),
  };
}

type Responder = (request: RelayRequest) => RelayResult | Promise<RelayResult>;

const OK_RESULT: RelayResult = { status: 200, data: { ok: true } };

/** Behaves like the real bookmarklet on the wire. */
export class FakeBookmarklet {
  /** Every request delivered to this bookmarklet, in order. */
  readonly seen: RelayRequest[] = [];
  private running = false;
  private currentPoll: http.ClientRequest | undefined;
  private loop: Promise<void> = Promise.resolve();
  private readonly browserHeaders: Record<string, string>;

  constructor(
    private readonly port: number,
    private readonly respond: Responder = () => OK_RESULT,
    realm: string = TEST_REALM,
  ) {
    this.browserHeaders = {
      Origin: `https://${realm}`,
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    };
  }

  async start(): Promise<void> {
    this.running = true;
    await this.hello();
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.currentPoll?.destroy();
    // A responder that never replies would keep the loop alive forever; do not wait for it.
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 200))]);
  }

  hello(): Promise<FullResponse> {
    return httpReqFull(
      'POST',
      this.port,
      '/relay/hello',
      JSON.stringify({ csrfToken: 'fake-csrf-token', realm: TEST_REALM }),
      this.browserHeaders,
    );
  }

  private poll(): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.port, path: '/relay/pending', method: 'GET', headers: this.browserHeaders },
        (res) => {
          let raw = '';
          res.on('data', (c: Buffer) => {
            raw += c.toString();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
        },
      );
      this.currentPoll = req;
      req.on('error', reject);
      req.end();
    });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        // Like the real bookmarklet's poll(): say hello first, so a restarted daemon re-attaches it.
        await this.hello().catch(() => undefined);
        const { status, body } = await this.poll();
        if (status !== 200) {
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        const request = JSON.parse(body) as RelayRequest;
        this.seen.push(request);
        const result = await this.respond(request);
        await httpReqFull('POST', this.port, `/relay/result/${request.id}`, JSON.stringify(result), this.browserHeaders);
      } catch {
        if (!this.running) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }
}
