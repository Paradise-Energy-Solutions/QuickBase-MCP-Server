import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  MAX_RELAY_PATH_LENGTH,
  assertValidRelayRequest,
  isFetchModeAllowed,
  isHostAllowed,
  isOriginAllowed,
  validateRelayHeaders,
  validateRelayMethod,
  validateRelayPath,
} from '../src/relay/validation';

describe('validateRelayPath', () => {
  const accepted = [
    '/api/v2/pipelines/query/paged?pageNumber=1&pageSize=25',
    '/api/v2/pipelines/123/designer?open=true',
    '/api/pipeohod/987',
    '/api/pipelines/1/pipes/2/select/export_fields',
    '/api/impersonation/realm/start',
    '/api/impersonation/end',
    // findPipelineUsers puts encodeURIComponent(query) in the path: %40 and %20 must stay legal.
    '/api/realm/findmatchingusers/jane%40example.com',
    '/api/realm/findmatchingusers/Jane%20Smith',
    '/api/v2/activity?start=1&end=2&scope=pipe&scope=poller&scope=pipeline&per_page=25&pipeline_id=9&pipeline_run_id=&offset=',
  ];

  it.each(accepted)('accepts %s', (p) => {
    expect(validateRelayPath(p)).toEqual({ ok: true });
  });

  const rejected: Array<[string, unknown, string]> = [
    ['undefined', undefined, 'string'],
    ['null', null, 'string'],
    ['a number', 5, 'string'],
    ['an object', {}, 'string'],
    ['the empty string', '', 'ASCII'],
    ['the bare /api/ prefix', '/api/', '/api/'],
    ['a missing leading slash', 'api/v2/x', '/api/'],
    ['a look-alike prefix', '/apix/y', '/api/'],
    ['an upper-case prefix', '/API/x', '/api/'],
    ['an absolute https URL', 'https://evil.example/api/x', '/api/'],
    ['a javascript: URL', 'javascript:alert(1)', '/api/'],
    ['a protocol-relative URL', '//evil.example/api/x', '/api/'],
    ['a host-extending path', '.evil.example/api/x', '/api/'],
    ['an authority-style path', '@evil.example/api/x', '/api/'],
    ['a double slash after the prefix', '/api//x', '//'],
    ['a double slash deeper in the path', '/api/v2//x', '//'],
    ['a URL smuggled in a query value', '/api/x?next=https://evil.example', '//'],
    ['dot-dot traversal', '/api/../admin', '..'],
    ['percent-encoded dot-dot', '/api/%2e%2e/admin', '%2e'],
    ['upper-case percent-encoded dot-dot', '/api/%2E%2E/admin', '%2e'],
    ['a mixed dot-segment', '/api/.%2e/x', '%2e'],
    ['a single encoded dot-segment', '/api/x/%2e/y', '%2e'],
    ['a backslash', '/api/x\\y', 'backslash'],
    ['a raw at-sign', '/api/x@evil.example', '@'],
    ['a fullwidth at-sign (U+FF20)', '/api/x＠evil.example', 'ASCII'],
    ['a fullwidth slash (U+FF0F)', '/api／x', 'ASCII'],
    ['other non-ASCII characters', '/api/café', 'ASCII'],
    ['a CR/LF header-injection attempt', '/api/x\r\nHost: evil.example', 'ASCII'],
    ['a tab', '/api/x\ty', 'ASCII'],
    ['a space', '/api/x y', 'ASCII'],
    ['a NUL byte', '/api/\u0000', 'ASCII'],
    ['an over-long path', `/api/${'a'.repeat(MAX_RELAY_PATH_LENGTH)}`, 'long'],
  ];

  it.each(rejected)('rejects %s', (_label, value, reasonFragment) => {
    const result = validateRelayPath(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reasonFragment);
  });

  it('accepts a path exactly at the length limit', () => {
    const p = `/api/${'a'.repeat(MAX_RELAY_PATH_LENGTH - '/api/'.length)}`;
    expect(p).toHaveLength(MAX_RELAY_PATH_LENGTH);
    expect(validateRelayPath(p)).toEqual({ ok: true });
  });
});

describe('validateRelayMethod', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('accepts %s', (m) => {
    expect(validateRelayMethod(m)).toEqual({ ok: true });
  });

  it.each([undefined, null, '', 'get', 'TRACE', 'CONNECT', 'GET ', 'POST\r\n', 5])(
    'rejects %j',
    (m) => {
      expect(validateRelayMethod(m).ok).toBe(false);
    },
  );
});

describe('validateRelayHeaders', () => {
  it('treats absent headers as valid', () => {
    expect(validateRelayHeaders(undefined)).toEqual({ ok: true });
    expect(validateRelayHeaders({})).toEqual({ ok: true });
  });

  it('accepts ordinary headers', () => {
    expect(
      validateRelayHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    ).toEqual({ ok: true });
  });

  it.each([null, [], 'Accept: x', 5])('rejects a non-object value %j', (h) => {
    expect(validateRelayHeaders(h).ok).toBe(false);
  });

  it.each(['Bad Name', 'X:Y', '', 'Café', 'a'.repeat(65)])('rejects the header name %j', (name) => {
    expect(validateRelayHeaders({ [name]: 'v' }).ok).toBe(false);
  });

  it.each([5, null, ['a'], 'line1\r\nInjected: yes', 'bad\nvalue', 'nul\u0000', 'x'.repeat(1025)])(
    'rejects the header value %j',
    (value) => {
      expect(validateRelayHeaders({ 'X-Custom': value as string }).ok).toBe(false);
    },
  );

  it.each([
    'X-CSRFToken',
    'x-csrftoken',
    'Cookie',
    'Set-Cookie',
    'Host',
    'Origin',
    'Referer',
    'Content-Length',
    'Transfer-Encoding',
    'Connection',
    'Upgrade',
  ])('refuses to let a caller set %s', (name) => {
    const result = validateRelayHeaders({ [name]: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain('not allowed');
  });

  it('rejects more than 20 headers', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 21; i++) many[`X-H${i}`] = 'v';
    expect(validateRelayHeaders(many).ok).toBe(false);
  });
});

describe('validateRelayHeaders: values a browser cannot send', () => {
  it('rejects a value outside the ByteString range (fetch would throw on it) and accepts Latin-1', () => {
    const euro = String.fromCharCode(0x20ac);
    const eAcute = String.fromCharCode(0xe9);
    expect(validateRelayHeaders({ 'X-Note': euro }).ok).toBe(false);
    expect(validateRelayHeaders({ 'X-Note': eAcute }).ok).toBe(true);
  });
});

describe('isHostAllowed', () => {
  it.each(['127.0.0.1:3737', 'localhost:3737', 'LOCALHOST:3737', 'Localhost:3737'])(
    'accepts %s for port 3737',
    (host) => {
      expect(isHostAllowed(host, 3737)).toBe(true);
    },
  );

  it.each([
    undefined,
    '',
    'evil.example',
    'evil.example:3737',
    '127.0.0.1',
    'localhost',
    '127.0.0.1:3738',
    'localhost:3738',
    '127.0.0.1.evil.example:3737',
    'localhost.evil.example:3737',
    '[::1]:3737',
    'user@127.0.0.1:3737',
    '0.0.0.0:3737',
  ])('rejects %p for port 3737 (DNS-rebinding defence)', (host) => {
    expect(isHostAllowed(host, 3737)).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  const realmOrigin = 'https://test.quickbase.com';

  it('treats a missing Origin as a same-process call', () => {
    expect(isOriginAllowed(undefined, realmOrigin)).toBe(true);
  });

  it('accepts the QB realm origin', () => {
    expect(isOriginAllowed(realmOrigin, realmOrigin)).toBe(true);
  });

  it.each(['', 'null', 'https://evil.example', 'http://test.quickbase.com', 'https://test.quickbase.com.evil.example'])(
    'rejects %j',
    (origin) => {
      expect(isOriginAllowed(origin, realmOrigin)).toBe(false);
    },
  );
});

describe('isFetchModeAllowed (Fetch Metadata)', () => {
  it('allows requests that carry no Sec-Fetch-Mode header (older browsers, non-browser clients)', () => {
    expect(isFetchModeAllowed(undefined)).toBe(true);
  });

  it.each(['cors', 'same-origin'])('allows %s', (mode) => {
    expect(isFetchModeAllowed(mode)).toBe(true);
  });

  it.each(['no-cors', 'navigate', 'websocket', '', 'CORS-ish'])('rejects %j', (mode) => {
    expect(isFetchModeAllowed(mode)).toBe(false);
  });

  it('rejects a repeated header', () => {
    expect(isFetchModeAllowed(['cors', 'no-cors'])).toBe(false);
  });
});

describe('assertValidRelayRequest', () => {
  it('does not throw for a valid request', () => {
    expect(() => assertValidRelayRequest('/api/pipeohod/1', 'GET', { Accept: 'text/plain' })).not.toThrow();
  });

  it('throws an InvalidParams McpError naming the rule, without echoing the offending path', () => {
    const attempt = () => assertValidRelayRequest('https://evil.example/steal', 'GET');
    expect(attempt).toThrow(McpError);
    try {
      attempt();
    } catch (err) {
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((err as McpError).message).toContain('/api/');
      expect((err as McpError).message).not.toContain('evil.example');
    }
  });

  it('rejects an invalid method and invalid headers with InvalidParams', () => {
    expect(() => assertValidRelayRequest('/api/x', 'TRACE')).toThrow(/method/i);
    expect(() => assertValidRelayRequest('/api/x', 'GET', { 'X-CSRFToken': 'stolen' })).toThrow(/not allowed/i);
  });
});
