/**
 * Types shared by the relay daemon, the in-daemon RelayClient and the
 * RemoteRelayClient used by every MCP instance.
 */

export type RelayResponseType = 'json' | 'text';

/** Bumped whenever the daemon's HTTP contract changes in a way an older MCP cannot speak. */
export const RELAY_PROTOCOL_VERSION = 1;

/** Header carrying the per-user secret on authenticated daemon calls (Node exposes it lower-cased). */
export const RELAY_SECRET_HEADER = 'X-QB-Relay-Secret';

/** What GET /relay/info returns: identity and build of a running daemon. No secrets. */
export interface RelayInfo {
  protocolVersion: number;
  /** package version + content hash of the relay build, e.g. "1.0.0+3fa9c1d2". */
  buildVersion: string;
  /** ISO time of the newest relay build file; orders two builds that share a protocol version. */
  buildTime: string;
  pid: number;
  startedAt: string;
  /** QuickBase host the daemon was started for. */
  realm: string;
}

export type RelayErrorKind =
  | 'invalid'
  | 'not_active'
  | 'timeout'
  | 'busy'
  | 'shutting_down'
  | 'unavailable'
  | 'internal';

/** Relay state echoed with every RPC answer so callers can cache isActive/currentUser. */
export interface RpcRelayState {
  active: boolean;
  realmUser: string | null;
}

/** Body of POST /relay/rpc. `owner` identifies the calling MCP process for the impersonation lock. */
export interface RpcRequestBody {
  owner: string;
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  responseType?: RelayResponseType;
}

export interface RpcSuccess {
  ok: true;
  result: RelayResult;
  relay: RpcRelayState;
}

export interface RpcFailure {
  ok: false;
  kind: RelayErrorKind | 'unauthorized' | 'forbidden';
  message: string;
  relay?: RpcRelayState;
  /** Who holds the impersonation lock, for kind "busy". */
  holder?: { owner: string; since: number };
}

export type RpcResponse = RpcSuccess | RpcFailure;

/** A request queued for the bookmarklet, as it travels over GET /relay/pending. */
export interface RelayRequest {
  id: string;
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  responseType?: RelayResponseType;
}

/** What the bookmarklet posts back for a request. `status` 0 means a network-level failure. */
export interface RelayResult {
  status: number;
  data: unknown;
  error?: string;
}

/**
 * The seam between QuickBaseClient and whatever carries Pipelines requests to
 * the user's browser: the in-daemon RelayClient or the RemoteRelayClient.
 */
export interface RelayTransport {
  request(
    path: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    responseType?: RelayResponseType
  ): Promise<RelayResult>;

  /** True when a bookmarklet is connected and its hello is fresh. */
  readonly isActive: boolean;
  /** The QuickBase host the connected bookmarklet reported, or null. */
  readonly currentUser: string | null;

  /**
   * Take the relay's exclusive impersonation lock. QuickBaseClient calls this
   * before starting an impersonation and releases it after the impersonation
   * ends, so concurrent MCP processes never run a call as each other's
   * identity. Optional so single-process transports and test doubles that have
   * no other clients to protect can omit it.
   */
  acquireExclusive?(): Promise<void>;
  releaseExclusive?(): Promise<void>;
}
