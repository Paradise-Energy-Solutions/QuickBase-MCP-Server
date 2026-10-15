/**
 * Types shared by the relay daemon, the in-daemon RelayClient and the
 * RemoteRelayClient used by every MCP instance.
 */

export type RelayResponseType = 'json' | 'text';

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
