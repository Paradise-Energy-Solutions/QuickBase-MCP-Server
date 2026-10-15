import { createHash } from 'node:crypto';
import http from 'node:http';
import vm from 'node:vm';
import { buildBookmarkletSource, buildSetupPage } from '../src/relay/server';
import { TEST_REALM, TestDaemon, startTestDaemon } from './helpers/daemonHarness';
import { httpReq, httpReqFull } from './helpers/relayHarness';

// The REAL bookmarklet source, evaluated in a vm sandbox that stands in for the
// QuickBase tab. Only fetch, timers, window and location are faked; fetch to
// http://localhost:<port> goes over real HTTP to a real in-process daemon, with
// the headers a browser sends from the QuickBase origin.

const TIME_SCALE = 50; // 5 s retry delays become 100 ms
const CSRF = 'fake-csrf-token';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface QuickBaseCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials?: string;
  body?: string;
}

class BrowserTab {
  readonly alerts: string[] = [];
  readonly quickbaseCalls: QuickBaseCall[] = [];
  private readonly inflight = new Set<http.ClientRequest>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly sandbox: Record<string, any>;

  constructor(private readonly port: number) {
    const window: Record<string, any> = { PIPELINES_PAGE_TOKEN: CSRF };
    this.sandbox = {
      window,
      location: { hostname: TEST_REALM },
      alert: (message: string) => this.alerts.push(message),
      fetch: (url: string, opts?: any) => this.fetch(url, opts ?? {}),
      setTimeout: (fn: () => void, ms: number) => this.track(setTimeout(fn, Math.max(1, Math.round(ms / TIME_SCALE)))),
      setInterval: (fn: () => void, ms: number) => this.track(setInterval(fn, Math.max(1, Math.round(ms / TIME_SCALE)))),
      clearInterval: (t: NodeJS.Timeout) => clearInterval(t),
    };
    // The bookmarklet uses bare `window.x`, so the sandbox global must expose the same names.
    window.window = window;
    vm.createContext(this.sandbox);
  }

  run(source: string): void {
    vm.runInContext(source, this.sandbox);
  }

  stop(): void {
    const window = this.sandbox.window as Record<string, any>;
    window['_qbRelayGen'] = (window['_qbRelayGen'] ?? 0) + 1; // makes every pending poll() return
    if (window['_qbRelayIv']) clearInterval(window['_qbRelayIv']);
    for (const req of this.inflight) req.destroy();
    for (const t of this.timers) clearTimeout(t);
  }

  private track(timer: NodeJS.Timeout): NodeJS.Timeout {
    this.timers.add(timer);
    return timer;
  }

  private fetch(url: string, opts: any): Promise<any> {
    const local = `http://localhost:${this.port}`;
    if (url.startsWith(local)) return this.fetchRelay(url.slice(local.length), opts);
    if (url.startsWith(`https://${TEST_REALM.replace('quickbase.com', 'pipelines.quickbase.com')}/`)) {
      return this.fetchQuickBase(url, opts);
    }
    return Promise.reject(new TypeError(`Unexpected fetch to ${url}`));
  }

  private fetchRelay(path: string, opts: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {
        ...(opts.headers ?? {}),
        Host: `localhost:${this.port}`,
        Origin: `https://${TEST_REALM}`,
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
      };
      if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);
      const req = http.request({ host: '127.0.0.1', port: this.port, path, method: opts.method ?? 'GET', headers }, (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => {
          raw += c.toString();
        });
        res.on('end', () => {
          this.inflight.delete(req);
          resolve({ status: res.statusCode, json: async () => JSON.parse(raw), text: async () => raw });
        });
      });
      this.inflight.add(req);
      req.on('error', () => {
        this.inflight.delete(req);
        reject(new TypeError('Failed to fetch'));
      });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  private async fetchQuickBase(url: string, opts: any): Promise<any> {
    this.quickbaseCalls.push({
      url,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      credentials: opts.credentials,
      body: opts.body,
    });
    const path = new URL(url).pathname;
    return { status: 200, json: async () => ({ echo: path }), text: async () => `yaml for ${path}` };
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms`);
}

const isActive = (port: number) => async () => ((await httpReq('GET', port, '/relay/status')).body as { active: boolean }).active === true;

describe('bookmarklet source', () => {
  it('is byte-for-byte the one already installed in browsers (golden hash from origin/main)', () => {
    const source = buildBookmarkletSource(TEST_REALM, 3737);
    const normalised = source.split('http://localhost:3737').join('http://localhost:PORT');

    expect(normalised).toHaveLength(2002);
    expect(sha256(normalised)).toBe('574800110f9fd8e1d68a6325a41ce387dd8d6449a4720a8e06d57bac4f44d9d2');
  });

  it('bakes in the relay port and the Pipelines host of the realm', () => {
    const source = buildBookmarkletSource(TEST_REALM, 3799);
    expect(source).toContain("var B='http://localhost:3799'");
    expect(source).toContain("var PL='https://test.pipelines.quickbase.com'");
  });

  it('is embedded unchanged in the setup page', () => {
    const page = buildSetupPage(TEST_REALM, 3737);
    expect(page).toContain(`javascript:${encodeURIComponent(buildBookmarkletSource(TEST_REALM, 3737))}`);
  });
});

describe('setup page wording', () => {
  const page = buildSetupPage(TEST_REALM, 3737);

  it('no longer tells people to restart the MCP server', () => {
    expect(page).not.toContain('restart the MCP server completely');
    expect(page).not.toMatch(/restart(ing)? the MCP server/i);
  });

  it('explains the shared daemon and when a new click is needed', () => {
    expect(page).toContain('shared background daemon');
    expect(page).toContain('click the bookmarklet again');
  });

  it('shows daemon pid, build and connected sessions when the daemon reports them', () => {
    expect(page).toContain('connected session');
  });

  it('still embeds the keepalive/hello endpoint', () => {
    expect(page).toContain('relay%2Fhello');
  });
});

describe('the real bookmarklet against the daemon', () => {
  const daemons: TestDaemon[] = [];
  const tabs: BrowserTab[] = [];

  afterEach(async () => {
    tabs.splice(0).forEach((t) => t.stop());
    await Promise.all(daemons.splice(0).map((d) => d.close()));
  });

  async function daemon(port?: number): Promise<TestDaemon> {
    const d = await startTestDaemon({ port });
    daemons.push(d);
    return d;
  }

  function openTab(port: number): BrowserTab {
    const tab = new BrowserTab(port);
    tabs.push(tab);
    tab.run(buildBookmarkletSource(TEST_REALM, port));
    return tab;
  }

  it('attaches, relays an RPC through the QuickBase tab with credentials and the CSRF token, and returns the result', async () => {
    const d = await daemon();
    const tab = openTab(d.port);
    await waitFor(isActive(d.port));

    const res = await d.rpc('owner-a', '/api/pipeohod/42');

    expect(res.body).toMatchObject({ ok: true, result: { status: 200, data: { echo: '/api/pipeohod/42' } } });
    expect(tab.quickbaseCalls).toHaveLength(1);
    expect(tab.quickbaseCalls[0]).toMatchObject({
      url: 'https://test.pipelines.quickbase.com/api/pipeohod/42',
      method: 'GET',
      credentials: 'include',
      headers: expect.objectContaining({ 'X-CSRFToken': CSRF }),
    });
    expect(tab.alerts).toHaveLength(1); // "QB Pipeline Relay active!" once
  });

  it('serves two MCP clients through the one attached tab', async () => {
    const d = await daemon();
    openTab(d.port);
    await waitFor(isActive(d.port));

    const [a, b] = await Promise.all([d.rpc('owner-a', '/api/one'), d.rpc('owner-b', '/api/two')]);

    expect(a.body).toMatchObject({ ok: true, result: { data: { echo: '/api/one' } } });
    expect(b.body).toMatchObject({ ok: true, result: { data: { echo: '/api/two' } } });
  });

  it('re-attaches by itself, with no click, when the daemon is killed and restarted on the same port', async () => {
    const first = await daemon();
    const port = first.port;
    const tab = openTab(port);
    await waitFor(isActive(port));
    expect((await first.rpc('owner-a', '/api/before')).body).toMatchObject({ ok: true });

    await first.close(); // the daemon dies; the tab is still open
    await expect(httpReqFull('GET', port, '/relay/status')).rejects.toBeDefined();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await daemon(port); // a NEW daemon on the same port
    await waitFor(isActive(port), 6000);
    const after = await second.rpc('owner-a', '/api/after');

    expect(after.body).toMatchObject({ ok: true, result: { data: { echo: '/api/after' } } });
    expect(tab.alerts).toHaveLength(1); // the bookmarklet was never run again
  });

  it('keeps working across several daemon restarts', async () => {
    let current = await daemon();
    const port = current.port;
    openTab(port);
    await waitFor(isActive(port));

    for (let i = 0; i < 3; i++) {
      await current.close();
      daemons.splice(daemons.indexOf(current), 1);
      current = await daemon(port);
      await waitFor(isActive(port), 6000);
      expect((await current.rpc('owner-a', `/api/round-${i}`)).body).toMatchObject({ ok: true });
    }
  });
});
