/**
 * RemoteRelayClient: the RelayTransport every MCP instance uses. It never binds
 * the relay port; it asks the shared relay daemon (see daemonRuntime.ts) to
 * carry each Pipelines request to the user's browser, over authenticated
 * loopback HTTP.
 *
 * The daemon is started lazily through the injected `ensureDaemon` (the
 * launcher), once for any number of concurrent calls, and again if the
 * connection is refused later (idle exit, crash, upgrade). A request is retried
 * only after a refused connection, never after a reset or timeout, because then
 * it may already have run.
 */

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { ControlConnectionError, getControl, postControl } from './controlClient.js';
import type { ControlResponse } from './controlClient.js';
import { RelayError } from './errors.js';
import type {
  RelayErrorKind,
  RelayResponseType,
  RelayResult,
  RelayTransport,
  RpcFailure,
  RpcRelayState,
  RpcRequestBody,
} from './types.js';
import { assertValidRelayRequest } from './validation.js';

const DEFAULT_RPC_TIMEOUT_MS = 75_000; // longer than the daemon's lock wait plus request timeout
const DEFAULT_REATTACH_WAIT_MS = 8_000;
const REATTACH_POLL_MS = 100;

export interface EnsureOutcome {
  /** True when a daemon was started just now (an open bookmarklet may still have to re-attach to it). */
  started: boolean;
}

export interface RemoteRelayClientOptions {
  port: number;
  /** Returns the shared secret; called again (once) if the daemon rejects it. */
  readSecret: () => string;
  /** Makes sure a compatible daemon is running; rejects with an actionable message if it cannot. */
  ensureDaemon: () => Promise<EnsureOutcome>;
  /** Identifies this MCP process to the daemon's impersonation lock. */
  ownerId?: string;
  rpcTimeoutMs?: number;
  /** How long after a fresh daemon start to wait for the open bookmarklet to re-attach. */
  reattachWaitMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultOwnerId(): string {
  const host = os.hostname().replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 100) || 'host';
  return `${host}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export class RemoteRelayClient implements RelayTransport {
  readonly ownerId: string;
  private readonly port: number;
  private readonly rpcTimeoutMs: number;
  private readonly reattachWaitMs: number;
  private ready: Promise<void> | undefined;
  private secret: string | undefined;
  private freshSince: number | undefined;
  private relayState: RpcRelayState = { active: false, realmUser: null };

  constructor(private readonly options: RemoteRelayClientOptions) {
    this.port = options.port;
    this.ownerId = options.ownerId ?? defaultOwnerId();
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.reattachWaitMs = options.reattachWaitMs ?? DEFAULT_REATTACH_WAIT_MS;
  }

  /** The relay's state as of the last answer from the daemon; advisory. */
  get isActive(): boolean {
    return this.relayState.active;
  }

  get currentUser(): string | null {
    return this.relayState.realmUser;
  }

  async request(
    path: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    responseType: RelayResponseType = 'json'
  ): Promise<RelayResult> {
    // Same rules the daemon applies; failing here is faster and never starts a daemon.
    assertValidRelayRequest(path, method, extraHeaders);

    const payload: RpcRequestBody = {
      owner: this.ownerId,
      path,
      method,
      ...(body !== undefined ? { body } : {}),
      ...(extraHeaders ? { headers: extraHeaders } : {}),
      responseType,
    };

    let response = await this.exchange('/relay/rpc', payload, this.rpcTimeoutMs);
    if (this.isNotActive(response) && this.withinReattachWindow()) {
      // The daemon was just started: the tab you already activated re-attaches by itself in a few seconds.
      if (await this.waitForReattach()) response = await this.exchange('/relay/rpc', payload, this.rpcTimeoutMs);
    }
    return this.unwrap(response);
  }

  async acquireExclusive(): Promise<void> {
    this.expectOk(await this.exchange('/relay/lock/acquire', { owner: this.ownerId }, this.rpcTimeoutMs));
  }

  async releaseExclusive(): Promise<void> {
    this.expectOk(await this.exchange('/relay/lock/release', { owner: this.ownerId }, this.rpcTimeoutMs));
  }

  /** Refreshes isActive/currentUser from GET /relay/status. Keeps the last known state if the daemon cannot be reached. */
  async refreshStatus(): Promise<void> {
    try {
      const { body } = await getControl({ port: this.port, timeoutMs: 2000 }, '/relay/status');
      if (isRecord(body) && typeof body.active === 'boolean') {
        this.relayState = { active: body.active, realmUser: typeof body.realmUser === 'string' ? body.realmUser : null };
      }
    } catch {
      /* keep the last known state */
    }
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.options.ensureDaemon().then(
        (outcome) => {
          if (outcome.started) this.freshSince = Date.now();
        },
        (err: unknown) => {
          this.ready = undefined; // try again on the next call
          throw this.unavailable(err instanceof Error ? err.message : String(err));
        }
      );
    }
    return this.ready;
  }

  private currentSecret(): string {
    if (this.secret === undefined) {
      try {
        this.secret = this.options.readSecret();
      } catch (err) {
        throw this.unavailable(`The relay secret could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.secret;
  }

  /** One authenticated POST, with the two recoveries that are safe: restart after a refused connection, re-read a rejected secret. */
  private async exchange(path: string, payload: unknown, timeoutMs: number): Promise<ControlResponse> {
    let restarted = false;
    let secretReread = false;
    for (;;) {
      await this.ensureReady();
      let response: ControlResponse;
      try {
        response = await postControl({ port: this.port, secret: this.currentSecret(), timeoutMs }, path, payload);
      } catch (err) {
        if (!(err instanceof ControlConnectionError)) throw err;
        if (err.refused && !restarted) {
          restarted = true;
          this.ready = undefined; // the daemon went away: ask the launcher for one again
          continue;
        }
        throw this.connectionFailure(err);
      }
      if (response.status === 401) {
        if (!secretReread) {
          secretReread = true;
          this.secret = undefined;
          continue;
        }
        throw this.unavailable(
          "The relay daemon rejected this session's credentials. The daemon was probably started by another user or with a different QB_RELAY_STATE_DIR (npm run relay:stop uses this session's secret and would be rejected too): stop that daemon from the account or state directory that started it, or set QB_RELAY_PORT to a different port."
        );
      }
      return response;
    }
  }

  private isNotActive(response: ControlResponse): boolean {
    return isRecord(response.body) && response.body.ok === false && response.body.kind === 'not_active';
  }

  private withinReattachWindow(): boolean {
    return this.freshSince !== undefined && Date.now() - this.freshSince < this.reattachWaitMs;
  }

  private async waitForReattach(): Promise<boolean> {
    const deadline = (this.freshSince ?? Date.now()) + this.reattachWaitMs;
    while (Date.now() < deadline) {
      await this.refreshStatus();
      if (this.relayState.active) return true;
      await new Promise((resolve) => setTimeout(resolve, REATTACH_POLL_MS));
    }
    return false;
  }

  private unwrap(response: ControlResponse): RelayResult {
    const { body } = response;
    if (isRecord(body) && body.ok === true && isRecord(body.result) && typeof body.result.status === 'number') {
      this.cacheState(body.relay);
      return body.result as unknown as RelayResult;
    }
    throw this.failure(response);
  }

  private expectOk(response: ControlResponse): void {
    if (isRecord(response.body) && response.body.ok === true) return;
    throw this.failure(response);
  }

  private failure(response: ControlResponse): RelayError {
    const { body } = response;
    if (isRecord(body) && body.ok === false && typeof body.kind === 'string' && typeof body.message === 'string') {
      const failure = body as unknown as RpcFailure;
      this.cacheState(failure.relay);
      const kind: RelayErrorKind = failure.kind === 'unauthorized' || failure.kind === 'forbidden' ? 'unavailable' : failure.kind;
      return new RelayError(kind, kind === 'invalid' ? ErrorCode.InvalidParams : ErrorCode.InternalError, failure.message);
    }
    return new RelayError(
      'internal',
      ErrorCode.InternalError,
      `The relay daemon sent an unexpected answer (HTTP ${response.status}).`
    );
  }

  private cacheState(state: unknown): void {
    if (isRecord(state) && typeof state.active === 'boolean') {
      this.relayState = { active: state.active, realmUser: typeof state.realmUser === 'string' ? state.realmUser : null };
    }
  }

  private connectionFailure(err: ControlConnectionError): RelayError {
    if (err.refused) {
      return this.unavailable(`The relay daemon refused the connection on port ${this.port}.`);
    }
    if (err.timedOut) {
      return this.unavailable(
        `The relay daemon did not answer in time (port ${this.port}). The request may or may not have run; check before retrying.`
      );
    }
    return this.unavailable(
      `The relay daemon stopped answering (${err.code}). The request may or may not have run; check before retrying.`
    );
  }

  private unavailable(detail: string): RelayError {
    return new RelayError(
      'unavailable',
      ErrorCode.InternalError,
      [
        'The QuickBase Pipeline relay daemon is not available.',
        '',
        detail,
        '',
        'Run "npm run relay:status" in the quickbase-mcp folder for details, and see the relay log in the state directory.',
      ].join('\n')
    );
  }
}
