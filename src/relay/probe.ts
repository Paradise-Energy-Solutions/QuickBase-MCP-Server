/**
 * Finds out what is listening on the relay port, without side effects.
 *
 *  - none:    nothing is listening.
 *  - daemon:  a relay daemon (it answers GET /relay/info with its identity).
 *  - legacy:  an old in-process relay (no /relay/info; /relay/status is exactly { active, realmUser }).
 *  - foreign: anything else, including a listener that never answers.
 *
 * Only GET requests to /relay/info and /relay/status are sent.
 */

import http from 'node:http';
import type { RelayInfo } from './types.js';

export type RelayProbe =
  | { kind: 'none' }
  | { kind: 'daemon'; info: RelayInfo }
  | { kind: 'legacy'; status: { active: boolean; realmUser: string | null } }
  | { kind: 'foreign' };

const MAX_PROBE_BYTES = 16 * 1024;

type Fetched = { status: number; body: unknown } | 'refused' | 'failed';

function getJson(port: number, path: string, timeoutMs: number): Promise<Fetched> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: Fetched) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Accept: 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_PROBE_BYTES) {
          req.destroy();
          settle('failed');
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
        settle({ status: res.statusCode ?? 0, body });
      });
      res.on('error', () => settle('failed'));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      settle('failed');
    });
    req.on('error', (err: NodeJS.ErrnoException) => settle(err.code === 'ECONNREFUSED' ? 'refused' : 'failed'));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRelayInfo(value: unknown): value is RelayInfo {
  return (
    isRecord(value) &&
    Number.isInteger(value.protocolVersion) &&
    typeof value.buildVersion === 'string' &&
    typeof value.buildTime === 'string' &&
    Number.isInteger(value.pid) &&
    typeof value.startedAt === 'string' &&
    typeof value.realm === 'string'
  );
}

function isLegacyStatus(value: unknown): value is { active: boolean; realmUser: string | null } {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 2 &&
    keys[0] === 'active' &&
    keys[1] === 'realmUser' &&
    typeof value.active === 'boolean' &&
    (value.realmUser === null || typeof value.realmUser === 'string')
  );
}

export async function probeRelay(port: number, timeoutMs = 1500): Promise<RelayProbe> {
  const info = await getJson(port, '/relay/info', timeoutMs);
  if (info === 'refused') return { kind: 'none' };
  if (info === 'failed') return { kind: 'foreign' };
  if (info.status === 200 && isRelayInfo(info.body)) return { kind: 'daemon', info: info.body };

  const status = await getJson(port, '/relay/status', timeoutMs);
  if (typeof status === 'object' && status.status === 200 && isLegacyStatus(status.body)) {
    return { kind: 'legacy', status: status.body };
  }
  return { kind: 'foreign' };
}
