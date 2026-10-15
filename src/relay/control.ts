/**
 * Authenticated control API of the shared relay daemon.
 *
 *   GET  /relay/info          identity of the daemon (no secret; browsers refused)
 *   POST /relay/rpc           relay one Pipelines request on behalf of an MCP process
 *   POST /relay/lock/acquire  take the exclusive impersonation lock
 *   POST /relay/lock/release  release it
 *   POST /relay/stop          stop the daemon (optionally only when idle)
 *
 * Every POST must come from a non-browser local client that knows the per-user
 * secret: any Origin header or Sec-Fetch-* header is refused (403) even with the
 * right secret, a missing or wrong secret is refused (401) and counts as no
 * activity. The Host check (DNS rebinding) is applied to every endpoint by the
 * server before requests reach this module.
 */

import type http from 'node:http';
import { RelayError } from './errors.js';
import { readBody, sendJson } from './httpUtil.js';
import { EXPIRY_OWNER, ImpersonationLock } from './lock.js';
import type { LockHolder } from './lock.js';
import { secretsMatch } from './secret.js';
import { RELAY_SECRET_HEADER } from './types.js';
import type {
  RelayErrorKind,
  RelayInfo,
  RelayResponseType,
  RelayResult,
  RpcFailure,
  RpcRelayState,
} from './types.js';
import { validateRelayHeaders, validateRelayMethod, validateRelayPath } from './validation.js';

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 20_000;
const CLIENT_WINDOW_MS = 10 * 60 * 1000;
const OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

const STATUS_BY_KIND: Record<RelayErrorKind, number> = {
  invalid: 400,
  not_active: 503,
  timeout: 504,
  busy: 423,
  shutting_down: 503,
  unavailable: 503,
  internal: 500,
};

export interface ControlOptions {
  /** The per-user shared secret. Never logged or echoed. */
  secret: string;
  info: RelayInfo;
  /** Called (after the HTTP answer is sent) when /relay/stop is accepted. */
  onStop: (reason: string) => void;
  /** A holder with no activity for this long is treated as abandoned (default 5 min). */
  lockTtlMs?: number;
  /** Longest a request or acquire waits behind another client's lock (default 20 s). */
  lockWaitMs?: number;
}

/** The slice of RelayClient the control API needs. */
export interface ControlRelay {
  request(
    path: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    responseType?: RelayResponseType
  ): Promise<RelayResult>;
  readonly isActive: boolean;
  readonly currentUser: string | null;
  readonly pendingCount: number;
  readonly queuedCount: number;
}

export interface ControlDeps {
  client: ControlRelay;
  options: ControlOptions;
  log: (line: string) => void;
  /** Reports client activity (feeds the daemon's idle timeout). */
  onActivity: () => void;
}

/** A path as it may appear in the log: no query string, no personal data in look-ups. */
export function pathForLog(path: string): string {
  const pathname = path.split('?')[0];
  return pathname.replace(/^(\/api\/realm\/findmatchingusers\/).*/, '$1<redacted>');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateOwner(owner: unknown): string | null {
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) {
    return 'owner must be 1-200 characters of letters, digits, ".", "_", ":" or "-"';
  }
  return null;
}

export class Control {
  private readonly lock: ImpersonationLock;
  private readonly clients = new Map<string, number>();
  private readonly startedMs = Date.now();
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;

  constructor(private readonly deps: ControlDeps) {
    this.lockTtlMs = deps.options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.lockWaitMs = deps.options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lock = new ImpersonationLock({
      ttlMs: this.lockTtlMs,
      onExpire: (owner) => this.endAbandonedImpersonation(owner),
    });
  }

  /** Answers the control routes; resolves false for anything else so the server can continue routing. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/relay/info') {
      this.info(req, res);
      return true;
    }
    if (req.method !== 'POST') return false;

    const route = this.postRoute(url);
    if (!route) return false;
    if (!this.authenticate(req, res, url)) return true;
    await route(req, res);
    return true;
  }

  /** Extra fields for GET /relay/status in daemon mode. */
  statusExtras(): Record<string, unknown> {
    const holder = this.lock.holder;
    const { info } = this.deps.options;
    return {
      pid: info.pid,
      protocolVersion: info.protocolVersion,
      buildVersion: info.buildVersion,
      startedAt: info.startedAt,
      uptimeSec: Math.floor((Date.now() - this.startedMs) / 1000),
      clients: this.countClients(),
      pending: this.deps.client.pendingCount,
      queued: this.deps.client.queuedCount,
      lock: holder ? { held: true, owner: holder.owner } : { held: false },
    };
  }

  /** True when stopping now would interrupt nobody: no bookmarklet, nothing in flight, no lock. */
  isIdle(): boolean {
    const { client } = this.deps;
    return !client.isActive && client.pendingCount === 0 && client.queuedCount === 0 && this.lock.holder === null && this.lock.waiting === 0;
  }

  shutdown(): void {
    this.lock.shutdown();
  }

  private postRoute(url: string): ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | undefined {
    switch (url) {
      case '/relay/rpc':
        return (req, res) => this.rpc(req, res);
      case '/relay/lock/acquire':
        return (req, res) => this.lockAcquire(req, res);
      case '/relay/lock/release':
        return (req, res) => this.lockRelease(req, res);
      case '/relay/stop':
        return (req, res) => this.stop(req, res);
      default:
        return undefined;
    }
  }

  private info(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers.origin !== undefined) {
      this.fail(res, 403, 'forbidden', 'Browser requests are not accepted');
      return;
    }
    sendJson(res, 200, this.deps.options.info);
  }

  /** Origin, Fetch Metadata and secret checks. Sends the refusal and returns false when the caller may not proceed. */
  private authenticate(req: http.IncomingMessage, res: http.ServerResponse, url: string): boolean {
    const fromBrowser =
      req.headers.origin !== undefined || Object.keys(req.headers).some((name) => name.startsWith('sec-fetch-'));
    if (fromBrowser) {
      this.deps.log(`refused ${req.method} ${url}: browser request (403)`);
      this.fail(res, 403, 'forbidden', 'Browser requests are not accepted');
      return false;
    }
    if (!secretsMatch(req.headers[RELAY_SECRET_HEADER.toLowerCase()], this.deps.options.secret)) {
      this.deps.log(`refused ${req.method} ${url}: missing or invalid relay secret (401)`);
      this.fail(res, 401, 'unauthorized', 'Missing or invalid relay secret');
      return false;
    }
    return true;
  }

  private fail(
    res: http.ServerResponse,
    status: number,
    kind: RpcFailure['kind'],
    message: string,
    extra: Partial<RpcFailure> = {}
  ): void {
    const failure: RpcFailure = { ok: false, kind, message, ...extra };
    sendJson(res, status, failure);
  }

  private async readObject(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | undefined> {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      this.fail(res, 400, 'invalid', err instanceof Error ? err.message : 'Invalid request body');
      return undefined;
    }
    if (body === null) return {};
    if (!isRecord(body)) {
      this.fail(res, 400, 'invalid', 'Body must be a JSON object');
      return undefined;
    }
    return body;
  }

  private relayState(): RpcRelayState {
    return { active: this.deps.client.isActive, realmUser: this.deps.client.currentUser };
  }

  private markClient(owner: string): void {
    this.clients.set(owner, Date.now());
    this.deps.onActivity();
  }

  private countClients(): number {
    const cutoff = Date.now() - CLIENT_WINDOW_MS;
    for (const [owner, lastSeen] of this.clients) {
      if (lastSeen < cutoff) this.clients.delete(owner);
    }
    return this.clients.size;
  }

  private busyMessage(holder: LockHolder | null): string {
    const who = holder ? `another Claude session (client ${holder.owner})` : 'another client';
    return (
      `The QuickBase Pipelines relay is busy: ${who} is running an impersonated pipeline operation. ` +
      `Retry in a few seconds. An abandoned impersonation is ended automatically ` +
      `${Math.round(this.lockTtlMs / 1000)} s after its last activity.`
    );
  }

  private busy(res: http.ServerResponse, holder: LockHolder | null): void {
    this.fail(res, 423, 'busy', this.busyMessage(holder), {
      relay: this.relayState(),
      ...(holder ? { holder: { owner: holder.owner, since: holder.since } } : {}),
    });
  }

  private async rpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readObject(req, res);
    if (!body) return;

    const problem =
      validateOwner(body.owner) ??
      (() => {
        for (const check of [validateRelayPath(body.path), validateRelayMethod(body.method), validateRelayHeaders(body.headers)]) {
          if (!check.ok) return check.reason;
        }
        if (body.responseType !== undefined && body.responseType !== 'json' && body.responseType !== 'text') {
          return 'responseType must be "json" or "text"';
        }
        return null;
      })();
    if (problem) {
      this.fail(res, 400, 'invalid', `Invalid relay request: ${problem}`);
      return;
    }

    const owner = body.owner as string;
    const path = body.path as string;
    const method = body.method as string;
    const started = Date.now();
    this.markClient(owner);

    const admission = await this.lock
      .admit(owner, this.lockWaitMs, () =>
        this.deps.client.request(
          path,
          method,
          body.body,
          body.headers as Record<string, string> | undefined,
          body.responseType as RelayResponseType | undefined
        )
      )
      .catch((err: unknown) => err as Error);
    if (admission instanceof Error) {
      this.answerError(res, admission, method, path, started);
      return;
    }
    if (!admission.admitted) {
      this.deps.log(`${method} ${pathForLog(path)} -> busy, held by ${admission.holder?.owner ?? 'unknown'} (${Date.now() - started} ms)`);
      this.busy(res, admission.holder);
      return;
    }

    try {
      const result = await admission.value;
      this.lock.touch(owner);
      sendJson(res, 200, { ok: true, result, relay: this.relayState() });
      this.deps.log(`${method} ${pathForLog(path)} -> ${result.status} (${Date.now() - started} ms)`);
    } catch (err) {
      this.answerError(res, err, method, path, started);
    }
  }

  private answerError(res: http.ServerResponse, err: unknown, method: string, path: string, started: number): void {
    const failure =
      err instanceof RelayError
        ? { kind: err.kind, message: err.detail }
        : { kind: 'internal' as RelayErrorKind, message: 'The relay hit an internal error; see the relay daemon log.' };
    if (!(err instanceof RelayError)) {
      this.deps.log(`internal error handling ${method} ${pathForLog(path)}: ${err instanceof Error ? err.message : String(err)}`);
    } else {
      this.deps.log(`${method} ${pathForLog(path)} -> ${failure.kind} (${Date.now() - started} ms)`);
    }
    this.fail(res, STATUS_BY_KIND[failure.kind], failure.kind, failure.message, { relay: this.relayState() });
  }

  private async lockAcquire(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readObject(req, res);
    if (!body) return;
    const problem = validateOwner(body.owner);
    if (problem) {
      this.fail(res, 400, 'invalid', problem);
      return;
    }
    const owner = body.owner as string;
    const requested = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) && body.waitMs >= 0 ? body.waitMs : this.lockWaitMs;
    this.markClient(owner);

    const granted = await this.lock.acquire(owner, Math.min(requested, this.lockWaitMs));
    if (!granted) {
      this.busy(res, this.lock.holder);
      return;
    }
    this.deps.log(`impersonation lock acquired by ${owner}`);
    sendJson(res, 200, { ok: true });
  }

  private async lockRelease(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readObject(req, res);
    if (!body) return;
    const problem = validateOwner(body.owner);
    if (problem) {
      this.fail(res, 400, 'invalid', problem);
      return;
    }
    const owner = body.owner as string;
    this.markClient(owner);
    const released = this.lock.release(owner);
    if (released) this.deps.log(`impersonation lock released by ${owner}`);
    sendJson(res, 200, { ok: true, released });
  }

  private async stop(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readObject(req, res);
    if (!body) return;
    const ifIdle = body.ifIdle === true;
    if (ifIdle && !this.isIdle()) {
      this.fail(res, 409, 'busy', 'The relay is in use (a bookmarklet is connected, a request is in flight, or an impersonation is active); not stopping.');
      return;
    }
    const reason = ifIdle ? 'stop requested (idle replacement)' : 'stop requested';
    sendJson(res, 200, { ok: true });
    setImmediate(() => this.deps.options.onStop(reason));
  }

  /** Lock TTL expired: end the abandoned impersonation in the browser before anyone else is served. */
  private async endAbandonedImpersonation(owner: string): Promise<void> {
    this.deps.log(`impersonation lock held by ${owner} expired after ${this.lockTtlMs} ms of inactivity; ending impersonation`);
    try {
      const admission = await this.lock.admit(EXPIRY_OWNER, 0, () =>
        this.deps.client.request('/api/impersonation/end', 'POST', {})
      );
      if (admission.admitted) await admission.value;
    } catch (err) {
      this.deps.log(`could not end the abandoned impersonation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
