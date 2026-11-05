/**
 * Error types for the relay. RelayError stays an McpError (so tool callers and
 * existing tests see the same shape as before) but also carries a machine-readable
 * `kind`, which lets the daemon map failures to HTTP statuses and the
 * RemoteRelayClient rebuild the same error on the other side of the wire.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { RelayErrorKind, RelayInfo } from './types.js';

export class RelayError extends McpError {
  readonly kind: RelayErrorKind;
  /** The message without McpError's "MCP error <code>:" prefix, so it can cross the wire without being double-prefixed. */
  readonly detail: string;

  constructor(kind: RelayErrorKind, code: ErrorCode, detail: string) {
    super(code, detail);
    this.kind = kind;
    this.detail = detail;
  }
}

/** Thrown through RelayServer.ready when a healthy relay daemon already owns the port. */
export class RelayAlreadyRunningError extends Error {
  readonly info: RelayInfo;

  constructor(info: RelayInfo) {
    super(`A relay daemon is already running on this port (pid ${info.pid}, build ${info.buildVersion}).`);
    this.name = 'RelayAlreadyRunningError';
    this.info = info;
  }
}

/** Thrown through RelayServer.ready when the port stays occupied by something that is not a relay daemon. */
export class RelayPortInUseError extends Error {
  readonly port: number;

  constructor(port: number, attempts: number) {
    super(`Relay port ${port} is still in use after ${attempts} attempts.`);
    this.name = 'RelayPortInUseError';
    this.port = port;
  }
}
