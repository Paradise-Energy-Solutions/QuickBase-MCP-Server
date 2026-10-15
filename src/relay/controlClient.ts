/**
 * Minimal loopback HTTP client for the relay daemon's control API. It sends the
 * per-user secret in a custom header and never an Origin or Fetch Metadata
 * header (the daemon refuses anything that looks like a browser).
 */

import http from 'node:http';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SECRET_HEADER = 'X-QB-Relay-Secret';

/**
 * A failure below HTTP: the connection was refused, reset or timed out.
 * Only `refused` is safe to retry, because then no connection existed and the
 * request cannot have run; after a reset or timeout it may have.
 */
export class ControlConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ControlConnectionError';
    this.code = code;
  }

  get refused(): boolean {
    return this.code === 'ECONNREFUSED';
  }

  get timedOut(): boolean {
    return this.code === 'ETIMEDOUT';
  }
}

export interface ControlTarget {
  port: number;
  /** Omit for the unauthenticated GET endpoints (/relay/info, /relay/status). */
  secret?: string;
  timeoutMs: number;
}

export interface ControlResponse {
  status: number;
  /** Parsed JSON, or undefined when the body was not JSON. */
  body: unknown;
}

function exchange(target: ControlTarget, method: 'GET' | 'POST', path: string, payload?: unknown): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { Accept: 'application/json' };
    let data: string | undefined;
    if (payload !== undefined) {
      data = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (target.secret) headers[SECRET_HEADER] = target.secret;

    // agent:false = a fresh connection per call. A pooled keep-alive socket to a daemon
    // that has since exited fails with ECONNRESET rather than ECONNREFUSED, which would
    // defeat the "refused means it never ran, so restart and retry" recovery.
    const req = http.request({ host: '127.0.0.1', port: target.port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new ControlConnectionError('EMSGSIZE', 'The relay daemon sent an oversized answer'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = undefined;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', (err: NodeJS.ErrnoException) => reject(new ControlConnectionError(err.code ?? 'ECONNRESET', err.message)));
    });
    req.setTimeout(target.timeoutMs, () => {
      req.destroy(new ControlConnectionError('ETIMEDOUT', `No answer within ${target.timeoutMs} ms`));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(err instanceof ControlConnectionError ? err : new ControlConnectionError(err.code ?? 'ECONNRESET', err.message));
    });
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export function postControl(target: ControlTarget, path: string, payload: unknown): Promise<ControlResponse> {
  return exchange(target, 'POST', path, payload);
}

export function getControl(target: ControlTarget, path: string): Promise<ControlResponse> {
  return exchange(target, 'GET', path);
}
