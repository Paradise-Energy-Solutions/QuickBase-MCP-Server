/**
 * Request and connection validation for the Pipeline relay.
 *
 * Why this matters: the bookmarklet runs `fetch(PL + req.path, ...)` inside the
 * user's logged-in QuickBase tab and attaches the session's CSRF token. An
 * unvalidated `path` could therefore point that token at another host or at a
 * non-API page. Every path is validated before it can be queued, both for
 * RPC callers and for the in-process RelayClient.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const MAX_RELAY_PATH_LENGTH = 2048;

const API_PREFIX = '/api/';
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const MAX_HEADER_COUNT = 20;
const MAX_HEADER_VALUE_LENGTH = 1024;
const ALLOWED_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ALLOWED_FETCH_MODES: readonly string[] = ['cors', 'same-origin'];

/** Headers a caller may never set: the bookmarklet owns the CSRF token and the browser owns the rest. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'x-csrftoken',
  'cookie',
  'set-cookie',
  'host',
  'origin',
  'referer',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
]);

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const OK: ValidationResult = { ok: true };

function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}

/**
 * A relay path is acceptable only if it can still only address the Pipelines
 * `/api/` tree on the fixed Pipelines host. Percent-encoded `%40` and `%2F` are
 * legal (an e-mail address is encoded into a path segment by findPipelineUsers);
 * encoded dot-segments (`%2e`) are not, because URL parsers treat them as `.`.
 */
export function validateRelayPath(path: unknown): ValidationResult {
  if (typeof path !== 'string') return fail('path must be a string');
  if (path.length > MAX_RELAY_PATH_LENGTH) {
    return fail(`path is too long (max ${MAX_RELAY_PATH_LENGTH} characters)`);
  }
  if (!PRINTABLE_ASCII.test(path)) {
    return fail('path must contain only printable ASCII characters (no whitespace or control characters)');
  }
  if (!path.startsWith(API_PREFIX) || path.length === API_PREFIX.length) {
    return fail(`path must start with ${API_PREFIX} and name an endpoint`);
  }
  if (path.includes('//')) return fail("path must not contain '//'");
  if (path.includes('..')) return fail("path must not contain '..'");
  if (/%2e/i.test(path)) return fail('path must not contain encoded dot-segments (%2e)');
  if (path.includes('\\')) return fail('path must not contain a backslash');
  if (path.includes('@')) return fail("path must not contain '@'");
  return OK;
}

export function validateRelayMethod(method: unknown): ValidationResult {
  if (typeof method === 'string' && ALLOWED_METHODS.includes(method)) return OK;
  return fail(`method must be one of ${ALLOWED_METHODS.join(', ')}`);
}

export function validateRelayHeaders(headers: unknown): ValidationResult {
  if (headers === undefined) return OK;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return fail('headers must be an object of strings');
  }
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > MAX_HEADER_COUNT) return fail(`headers may contain at most ${MAX_HEADER_COUNT} entries`);

  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) return fail('header names may contain only letters, digits and hyphens (max 64 characters)');
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) return fail(`header ${name} is not allowed`);
    if (typeof value !== 'string') return fail(`header ${name} must have a string value`);
    if (value.length > MAX_HEADER_VALUE_LENGTH) return fail(`header ${name} is too long`);
    if (CONTROL_CHARS.test(value)) return fail(`header ${name} contains control characters`);
  }
  return OK;
}

/**
 * DNS-rebinding defence: the relay listens on 127.0.0.1 only, so the only
 * legitimate Host values are 127.0.0.1:<port> and localhost:<port>. A rebound
 * attacker domain would arrive with its own name in Host.
 */
export function isHostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const normalised = host.toLowerCase();
  return normalised === `127.0.0.1:${port}` || normalised === `localhost:${port}`;
}

/**
 * Returns true when the request origin is acceptable:
 *  - No Origin header  -> same-process HTTP request (node:http.request), always allowed.
 *  - Origin matches the QB realm -> bookmarklet running on the QB domain, allowed.
 *  - Any other origin  -> cross-site request, denied.
 *
 * Only `origin === undefined` is treated as a same-process call. An empty-string
 * or `"null"` origin originates from a browser context (sandboxed iframes, file://
 * pages) and must be rejected, not trusted.
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigin: string): boolean {
  if (origin === undefined) return true;
  return origin === allowedOrigin;
}

/**
 * Fetch Metadata guard for the bookmarklet-facing endpoints. The bookmarklet
 * always issues CORS-mode fetches; a `no-cors` or `navigate` request (an
 * <img>, <script> or link pointed at localhost by some other page) is refused.
 * Browsers that send no Sec-Fetch-Mode header are not blocked here; the Origin
 * and Host checks still apply.
 */
export function isFetchModeAllowed(mode: string | string[] | undefined): boolean {
  if (mode === undefined) return true;
  return typeof mode === 'string' && ALLOWED_FETCH_MODES.includes(mode);
}

/** Throws an InvalidParams McpError describing the first violated rule (never echoing the offending value). */
export function assertValidRelayRequest(path: unknown, method: unknown, headers?: unknown): void {
  for (const result of [validateRelayPath(path), validateRelayMethod(method), validateRelayHeaders(headers)]) {
    if (!result.ok) throw new McpError(ErrorCode.InvalidParams, `Invalid relay request: ${result.reason}`);
  }
}
