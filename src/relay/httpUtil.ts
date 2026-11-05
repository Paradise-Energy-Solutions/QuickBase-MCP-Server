/** Small HTTP helpers shared by the relay server and its control API. */

import type http from 'node:http';

export const MAX_BODY_BYTES = 1_048_576; // 1 MB — protect against runaway payloads

/**
 * Reads and JSON-parses the body of an incoming HTTP request.
 * Rejects if the body exceeds MAX_BODY_BYTES or is not valid JSON.
 * An empty body resolves to `null`.
 *
 * @param req - The raw Node.js incoming message to read from.
 * @returns A Promise that resolves to the parsed JSON value.
 */
export function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    req.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body exceeds 1 MB limit'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw || 'null')); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** Writes a JSON response with the given status. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
