/**
 * Shared helpers for the relay test files: free-port discovery and tiny HTTP
 * clients that can override Host/Origin/Sec-Fetch-* headers (Node's http client
 * lets tests send exactly what a hostile web page or DNS-rebinding attack would).
 *
 * Tests must only ever bind OS-assigned ports; never the live relay port.
 */

import http from 'node:http';
import net from 'node:net';

export interface FullResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  body: unknown;
}

/** Binds to port 0 and immediately closes to obtain an OS-assigned free port. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Polls until a TCP connection to the port succeeds or the timeout elapses. */
export async function waitForPort(port: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`Port ${port} did not open within ${timeoutMs} ms`);
}

/** Sends one request to 127.0.0.1:<port>; `extraHeaders` may override Host, Origin and so on. */
export function httpReqFull(
  method: string,
  port: number,
  path: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<FullResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...extraHeaders };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => {
        raw += c.toString();
      });
      res.on('end', () => {
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw || 'null');
        } catch {
          /* keep the raw text */
        }
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Convenience wrapper returning only status and body. */
export async function httpReq(
  method: string,
  port: number,
  path: string,
  body?: string,
): Promise<{ statusCode: number; body: unknown }> {
  const { statusCode, body: parsed } = await httpReqFull(method, port, path, body);
  return { statusCode, body: parsed };
}
