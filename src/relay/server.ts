/**
 * Pipeline Browser Relay Server
 *
 * The QuickBase Pipelines API has no machine-to-machine auth — it requires
 * a live browser session (HttpOnly cookies set during QB login). This relay
 * server bridges that gap:
 *
 *   1. MCP tool calls queue a request here.
 *   2. A bookmarklet running on the QB domain picks it up via long-poll.
 *   3. The bookmarklet makes the fetch with credentials:include (browser
 *      handles the HttpOnly cookies automatically).
 *   4. The bookmarklet posts the result back here.
 *   5. The queued MCP tool call resolves.
 *
 * The relay binds to 127.0.0.1 only and accepts CORS only from the QB realm
 * domain — no external access, no SSRF risk. Every request must also carry a
 * Host of 127.0.0.1:<port> or localhost:<port> (DNS-rebinding defence), the
 * bookmarklet endpoints require the QB realm Origin and a CORS-mode fetch, and
 * relay paths are validated (see validation.ts) before they can be queued.
 */

import http from 'node:http';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { Control } from './control.js';
import type { ControlOptions } from './control.js';
import { RelayAlreadyRunningError, RelayError, RelayPortInUseError } from './errors.js';
import { readBody, sendJson } from './httpUtil.js';
import { probeRelay } from './probe.js';
import type { RelayRequest, RelayResponseType, RelayResult, RelayTransport } from './types.js';
import {
  assertValidRelayRequest,
  isFetchModeAllowed,
  isHostAllowed,
  isOriginAllowed,
} from './validation.js';

interface PendingEntry {
  resolve: (result: RelayResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface HelloState {
  csrfToken: string;
  realm: string;
  receivedAt: number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const RELAY_ACTIVE_TTL_MS = 5 * 60 * 1000; // 5 minutes since last hello
const LONG_POLL_TIMEOUT_MS = 28_000; // hold long-poll just under the client timeout
const RETRY_DELAYS_MS = [500, 500, 1000, 1000, 2000]; // EADDRINUSE backoff — ~5 s total

export interface RelayClientOptions {
  /** How long a request may wait for the bookmarklet's answer (default 30 s). */
  requestTimeoutMs?: number;
}

export class RelayClient implements RelayTransport {
  private pending: Map<string, PendingEntry> = new Map();
  private queue: RelayRequest[] = [];
  private longPollRes: http.ServerResponse | null = null;
  private helloState: HelloState | null = null;
  private port: number;
  private readonly requestTimeoutMs: number;

  constructor(port: number, opts: RelayClientOptions = {}) {
    this.port = port;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Requests sent to the bookmarklet that have not been answered yet. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Requests waiting for the bookmarklet's next poll. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Called by the relay HTTP server when the bookmarklet POSTs /relay/hello */
  receiveHello(csrfToken: string, realm: string): void {
    this.helloState = { csrfToken, realm, receivedAt: Date.now() };
    // If a long-poll is waiting and there are queued items, dispatch now
    this.dispatchNextRequest();
  }

  /** Called by the relay HTTP server when the bookmarklet POSTs /relay/result/:id */
  receiveResult(id: string, result: RelayResult): void {
    // Refresh activity — a result response proves the bookmarklet is alive.
    if (this.helloState) this.helloState.receivedAt = Date.now();
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(result);
  }

  /** Called by the relay HTTP server when a GET /relay/pending arrives */
  registerLongPoll(res: http.ServerResponse): void {
    // Refresh activity — each long-poll proves the bookmarklet is still alive.
    if (this.helloState) this.helloState.receivedAt = Date.now();
    // Replace any stale long-poll connection
    if (this.longPollRes && !this.longPollRes.writableEnded) {
      this.longPollRes.writeHead(204).end();
    }
    this.longPollRes = res;
    // A dropped connection (tab closed or reloaded) must not stay registered: the
    // next request would be written to a dead socket and lost. Forget it instead,
    // so the request waits for the bookmarklet's next poll.
    res.on('close', () => {
      if (this.longPollRes === res) this.longPollRes = null;
    });
    this.dispatchNextRequest();

    // Auto-close after LONG_POLL_TIMEOUT_MS so the bookmarklet reconnects
    setTimeout(() => {
      if (this.longPollRes === res && !res.writableEnded) {
        this.longPollRes = null;
        res.writeHead(204).end();
      }
    }, LONG_POLL_TIMEOUT_MS).unref();
  }

  /** True when a bookmarklet is connected and the hello is fresh */
  get isActive(): boolean {
    if (!this.helloState) return false;
    return Date.now() - this.helloState.receivedAt < RELAY_ACTIVE_TTL_MS;
  }

  get currentUser(): string | null {
    return this.helloState?.realm ?? null;
  }

  /** Queue a request and return a Promise that resolves with the relay result */
  async request(
    path: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    responseType: RelayResponseType = 'json'
  ): Promise<RelayResult> {
    // The bookmarklet does fetch(PL + path) with the user's CSRF token, so the
    // path is validated before anything can be queued, ahead of the active check.
    assertValidRelayRequest(path, method, extraHeaders);

    if (!this.isActive) {
      throw new RelayError('not_active', ErrorCode.InternalError, this.notActiveMessage());
    }

    const req: RelayRequest = { id: randomUUID(), path, method, body, headers: extraHeaders, responseType };

    return new Promise<RelayResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        // Withdraw it from the queue too: a request nobody is waiting for must
        // never run late (a stale impersonation start would be dangerous).
        this.queue = this.queue.filter((queued) => queued.id !== req.id);
        reject(new RelayError('timeout', ErrorCode.InternalError, this.timeoutMessage()));
      }, this.requestTimeoutMs);
      timer.unref();

      this.pending.set(req.id, { resolve, reject, timer });
      this.queue.push(req);
      this.dispatchNextRequest();
    });
  }

  /**
   * If a long-poll connection is waiting and the queue has an item,
   * send the next queued request to the bookmarklet and clear the connection.
   * Intentionally handles exactly one request per call — the protocol is
   * one long-poll → one response → bookmarklet reconnects.
   */
  private dispatchNextRequest(): void {
    if (!this.longPollRes || this.longPollRes.writableEnded) return;
    const next = this.queue.shift();
    if (!next) return;

    const body = JSON.stringify(next);
    const res = this.longPollRes;
    this.longPollRes = null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  private notActiveMessage(): string {
    return [
      'The QuickBase Pipeline relay is not active.',
      '',
      'To activate it:',
      `1. Visit http://localhost:${this.port}/setup in your browser for first-time setup (drag the bookmarklet to your bookmarks toolbar).`,
      '2. Navigate to the QuickBase Pipelines dashboard (the bookmarklet only works from that page).',
      '3. Click the "QB Pipeline Relay" bookmarklet in your toolbar.',
      '   Direct link: https://<your-realm>/nav/main/action/pipelines/dashboard',
      '4. You will see a confirmation message. Then retry this tool.',
      '',
      'The relay runs as one shared background daemon, so this is needed only once per browser tab: it keeps running when Claude sessions start or close, and a Pipelines tab you already activated reconnects by itself within a few seconds if the daemon restarts. Click the bookmarklet again only if the tab was closed or reloaded.',
    ].join('\n');
  }

  private timeoutMessage(): string {
    return [
      'The QuickBase Pipeline relay timed out.',
      '',
      'The browser tab running the relay may have been closed, reloaded, navigated away, or gone idle.',
      'Navigate to the QuickBase Pipelines dashboard and click the "QB Pipeline Relay" bookmarklet to reconnect, then retry this tool.',
      '(The bookmarklet only works from the Pipelines dashboard page, not other QuickBase pages.)',
      `Setup page: http://localhost:${this.port}/setup`,
    ].join('\n');
  }

  /**
   * Gracefully tear down the relay: reject pending tool requests, drop anything
   * still queued and close any open long-poll connection. Called when the
   * daemon stops.
   */
  shutdown(): void {
    if (this.longPollRes && !this.longPollRes.writableEnded) {
      // Use a clean 204 rather than socket.destroy() so the bookmarklet's
      // catch path retries in 2 s (normal long-poll reconnect) rather than 5 s.
      this.longPollRes.writeHead(204).end();
      this.longPollRes = null;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new RelayError('shutting_down', ErrorCode.InternalError, 'Relay server shutting down'));
    }
    this.pending.clear();
    this.queue = [];
  }
}

/**
 * Validate realm before interpolating into HTML or JavaScript to prevent latent
 * XSS if the value ever flows from a less-trusted config source: only
 * [a-zA-Z0-9.-] survive.
 */
function sanitiseRealm(realm: string): string {
  return realm.replace(/[^a-zA-Z0-9.-]/g, '');
}

/**
 * The bookmarklet's JavaScript source. Exported so tests can run the exact
 * string browsers execute. Its text and the three endpoints it calls
 * (/relay/hello, /relay/pending, /relay/result/:id) must stay stable: installed
 * bookmarks never refresh, so the daemon has to keep serving them. A golden hash
 * in tests/relay-bookmarklet.test.ts pins it.
 *
 * @param realm - The QuickBase realm hostname (e.g. "myorg.quickbase.com").
 * @param port - The TCP port the relay server is listening on.
 */
export function buildBookmarkletSource(realm: string, port: number): string {
  const safeRealm = sanitiseRealm(realm);
  const pipelinesBase = `https://${safeRealm.replace('quickbase.com', 'pipelines.quickbase.com')}`;
  const relayBase = `http://localhost:${port}`;

  // Bookmarklet source — minified inline JS
  // Uses window.PIPELINES_PAGE_TOKEN (QB sets this on every page) as the CSRF token.
  return `(function(){
var B='${relayBase}';
var PL='${pipelinesBase}';
var T=window['PIPELINES_PAGE_TOKEN'];
if(!T){alert('QB Pipeline Relay: Could not find PIPELINES_PAGE_TOKEN.\\n\\nNavigate to the Pipelines dashboard first:\\nhttps://'+location.hostname+'/nav/main/action/pipelines/dashboard');return;}
if(window['_qbRelayIv']){clearInterval(window['_qbRelayIv']);}
window['_qbRelayGen']=(window['_qbRelayGen']||0)+1;
var gen=window['_qbRelayGen'];
var lastPoll=0;
function hello(){T=window['PIPELINES_PAGE_TOKEN']||T;return fetch(B+'/relay/hello',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrfToken:T,realm:location.hostname})}).catch(function(){});}
hello();
window['_qbRelayIv']=setInterval(function(){hello();if(Date.now()-lastPoll>35000)poll();},240000);
function poll(){
if(window['_qbRelayGen']!==gen)return;
lastPoll=Date.now();
hello().then(function(){return fetch(B+'/relay/pending');}).then(function(r){
if(r.status!==200){hello();return null;}
return r.json();
}).then(function(req){
if(!req){setTimeout(poll,2000);return;}
var opts={method:req.method||'GET',credentials:'include',headers:Object.assign({'X-CSRFToken':T,'Accept':'application/json'},req.headers||{})};
if(req.body&&req.method!=='GET'){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(req.body);}
fetch(PL+req.path,opts).then(function(r){var parse=req.responseType==='text'?r.text():r.json();return parse.then(function(d){return{status:r.status,data:d};});}).then(function(result){
return fetch(B+'/relay/result/'+req.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
}).then(poll).catch(function(e){
fetch(B+'/relay/result/'+req.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:0,data:null,error:e.message})}).catch(function(){}).then(poll);
});
}).catch(function(){hello();setTimeout(poll,5000);});
}
poll();
alert('\\u2705 QB Pipeline Relay active!');
})();`;
}

/**
 * Generates the HTML setup page that walks the user through installing the
 * bookmarklet and activating the relay.
 *
 * @param realm - The QuickBase realm hostname (e.g. "myorg.quickbase.com").
 *   Only [a-zA-Z0-9.-] pass through sanitisation before interpolation.
 * @param port - The TCP port the relay server is listening on.
 * @returns A complete HTML document string ready to serve as text/html.
 */
export function buildSetupPage(realm: string, port: number): string {
  const safeRealm = sanitiseRealm(realm);
  const encoded = `javascript:${encodeURIComponent(buildBookmarkletSource(realm, port))}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QB Pipeline Relay — Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 24px; color: #1a1a1a; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .subtitle { color: #666; margin-bottom: 32px; }
  .step { display: flex; gap: 16px; margin-bottom: 24px; align-items: flex-start; }
  .step-num { background: #0066cc; color: white; border-radius: 50%; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-weight: bold; flex-shrink: 0; font-size: 0.9rem; }
  .step-body h3 { margin: 0 0 4px; font-size: 1rem; }
  .step-body p { margin: 0; color: #555; font-size: 0.9rem; }
  .bookmarklet-wrap { margin: 8px 0; }
  a.bookmarklet { display: inline-block; padding: 10px 20px; background: #f0f0f0; border: 2px dashed #0066cc; border-radius: 8px; font-weight: bold; color: #0066cc; text-decoration: none; cursor: grab; font-size: 1rem; }
  a.bookmarklet:active { cursor: grabbing; }
  .drag-hint { font-size: 0.8rem; color: #888; margin-top: 6px; }
  .status-bar { margin-top: 40px; padding: 12px 16px; border-radius: 8px; background: #f5f5f5; font-size: 0.9rem; color: #555; }
  .status-bar span { font-weight: bold; }
</style>
</head>
<body>
<h1>QB Pipeline Relay</h1>
<p class="subtitle">One-time setup to enable QuickBase Pipeline tools in your AI agent.</p>

<div class="step">
  <div class="step-num">1</div>
  <div class="step-body">
    <h3>Drag the bookmarklet to your bookmarks toolbar</h3>
    <div class="bookmarklet-wrap">
      <a class="bookmarklet" href="${encoded}">&#9889; QB Pipeline Relay</a>
    </div>
    <p class="drag-hint">Drag the button above to your browser's bookmarks bar. If your bookmarks bar is hidden, press Ctrl+Shift+B (Windows) or Cmd+Shift+B (Mac) to show it.</p>
  </div>
</div>

<div class="step">
  <div class="step-num">2</div>
  <div class="step-body">
    <h3>Open the QuickBase Pipelines dashboard</h3>
    <p>Navigate to <a href="https://${safeRealm}/nav/main/action/pipelines/dashboard" target="_blank">the Pipelines dashboard</a> in your browser. Make sure you are already logged in. The bookmarklet only works from this page because QuickBase only loads the Pipelines session token there.</p>
  </div>
</div>

<div class="step">
  <div class="step-num">3</div>
  <div class="step-body">
    <h3>Click the bookmarklet</h3>
    <p>Click <strong>&#9889; QB Pipeline Relay</strong> in your bookmarks toolbar. You will see a confirmation popup. The relay is now active — your agent can use pipeline tools.</p>
  </div>
</div>

<div class="step">
  <div class="step-num">4</div>
  <div class="step-body">
    <h3>Keeping the relay alive</h3>
    <p>The relay runs as one shared background daemon, so you only click the bookmarklet once per browser tab, however many Claude sessions you open or close. The bookmarklet sends a keepalive every 4 minutes and reconnects by itself within a few seconds if the daemon restarts, so a Pipelines tab you already activated stays connected for as long as it is open. If you close or reload the tab, return to the <a href="https://${safeRealm}/nav/main/action/pipelines/dashboard" target="_blank">Pipelines dashboard</a> and click the bookmarklet again.</p>
  </div>
</div>

<div class="status-bar" id="status">Checking relay status&hellip;</div>
<p class="drag-hint" id="daemon"></p>

<script>
fetch('/relay/status').then(r=>r.json()).then(d=>{
  const el=document.getElementById('status');
  if(d.active){el.style.background='#e6f4ea';el.style.color='#1e7e34';el.innerHTML='&#10003; <span>Relay is active.</span> Pipeline tools are ready.';}
  else{el.innerHTML='&#9888; <span>Relay is not yet active.</span> Follow steps 2 and 3 above.';}
  if(d.pid){document.getElementById('daemon').textContent='Relay daemon pid '+d.pid+' · build '+d.buildVersion+' · '+d.clients+' connected session(s) · up '+d.uptimeSec+' s';}
}).catch(()=>{});
</script>
</body>
</html>`;
}

/** Applies CORS response headers, restricting the allowed origin to the QB realm. */
function cors(res: http.ServerResponse, allowedOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/** Sends a 403 Forbidden JSON response. Used when a request fails the Host, Origin or Fetch Metadata checks. */
function sendForbidden(res: http.ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Forbidden' }));
}

/**
 * Guards the endpoints only the bookmarklet (or a same-process caller) may use.
 * Sends 403 and returns true when the request must not proceed: its Origin is
 * not the QB realm (an absent Origin is a same-process call), or its
 * Sec-Fetch-Mode says it was not issued by a CORS-mode fetch.
 *
 * This keeps other web pages from activating the relay, consuming queued
 * requests or posting forged results, including simple cross-site requests
 * that bypass CORS preflight.
 */
function refuseUnlessBookmarklet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigin: string
): boolean {
  const origin = req.headers.origin as string | undefined;
  if (isOriginAllowed(origin, allowedOrigin) && isFetchModeAllowed(req.headers['sec-fetch-mode'])) {
    return false;
  }
  sendForbidden(res);
  return true;
}

export interface RelayServerOptions {
  /** Enables the authenticated daemon control API (rpc, lock, stop, info). Omit for a plain relay. */
  control?: ControlOptions;
  /** How long a request may wait for the bookmarklet's answer (default 30 s). */
  requestTimeoutMs?: number;
  /** Where log lines go (default: stderr). */
  log?: (line: string) => void;
  /** Called on bookmarklet and client traffic (not on probes); feeds the daemon's idle timeout. */
  onActivity?: () => void;
}

export interface RelayServer {
  readonly client: RelayClient;
  readonly port: number;
  /**
   * Resolves once the server is listening. Rejects with RelayAlreadyRunningError when a
   * healthy relay daemon already holds the port, or RelayPortInUseError when something
   * else keeps it after the retries. Never an unhandled rejection if nobody awaits it.
   */
  readonly ready: Promise<void>;
  /** Stops listening, rejects pending requests and releases the port. Safe to call repeatedly. */
  close(): Promise<void>;
}

/**
 * Starts the relay HTTP server. Binds to 127.0.0.1 only.
 *
 * On EADDRINUSE it asks the occupant who it is (GET /relay/info). A healthy relay
 * daemon means this newcomer has nothing to do (RelayAlreadyRunningError); anything
 * else is retried with a short backoff, since the port may still be in TIME_WAIT
 * after a previous process exited. It never asks the occupant to shut down: replacing
 * a daemon or a legacy relay is the launcher's explicit, authenticated decision.
 *
 * @param realm - The QuickBase realm hostname (e.g. "myorg.quickbase.com").
 *   Used to restrict CORS and to build the setup-page URL.
 * @param port - The TCP port to listen on.
 */
export function startRelayServer(realm: string, port: number, options: RelayServerOptions = {}): RelayServer {
  const log = options.log ?? ((line: string) => console.error(line));
  const onActivity = options.onActivity ?? (() => {});
  const client = new RelayClient(port, { requestTimeoutMs: options.requestTimeoutMs });
  const allowedOrigin = `https://${realm}`;
  const control = options.control ? new Control({ client, options: options.control, log, onActivity }) : undefined;

  const server = http.createServer(async (req, res) => {
    // DNS-rebinding defence: refuse before emitting any CORS headers.
    if (!isHostAllowed(req.headers.host, port)) {
      sendForbidden(res);
      return;
    }

    cors(res, allowedOrigin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = req.url ?? '/';

    if (control && (await control.handle(req, res))) return;

    // ── GET /setup ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/setup') {
      const html = buildSetupPage(realm, port);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ── GET /relay/status ────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/relay/status') {
      sendJson(res, 200, { active: client.isActive, realmUser: client.currentUser, ...control?.statusExtras() });
      return;
    }

    // ── POST /relay/shutdown (legacy) ────────────────────────────────────────
    // Old builds POST here when they find the port taken, to make the holder step
    // aside. The relay is now one daemon shared by every session, so it is refused
    // whoever asks; stopping it takes the authenticated /relay/stop.
    if (req.method === 'POST' && url === '/relay/shutdown') {
      log('refused POST /relay/shutdown (legacy shutdown request; this relay is a shared daemon)');
      sendJson(res, 403, {
        error: 'Forbidden',
        message: 'This relay is shared by every Claude session and cannot be shut down this way. To stop it, run: npm run relay:stop',
      });
      return;
    }

    // ── GET /relay/pending ────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/relay/pending') {
      if (refuseUnlessBookmarklet(req, res, allowedOrigin)) return;
      onActivity();
      client.registerLongPoll(res);
      return;
    }

    // ── POST /relay/hello ─────────────────────────────────────────────────────
    if (req.method === 'POST' && url === '/relay/hello') {
      if (refuseUnlessBookmarklet(req, res, allowedOrigin)) return;
      onActivity();
      try {
        const body = await readBody(req) as { csrfToken: string; realm: string };
        if (typeof body?.csrfToken === 'string' && body.csrfToken && typeof body?.realm === 'string' && body.realm) {
          client.receiveHello(body.csrfToken, body.realm);
        }
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
      return;
    }

    // ── POST /relay/result/:id ────────────────────────────────────────────────
    const resultMatch = url.match(/^\/relay\/result\/([a-f0-9-]{36})$/);
    if (req.method === 'POST' && resultMatch) {
      if (refuseUnlessBookmarklet(req, res, allowedOrigin)) return;
      onActivity();
      try {
        const result = await readBody(req) as RelayResult;
        if (typeof result !== 'object' || result === null || typeof result.status !== 'number') {
          res.writeHead(400).end(); // not a relay result: never resolve a pending call with it
          return;
        }
        client.receiveResult(resultMatch[1], result);
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
      return;
    }

    res.writeHead(404).end();
  });

  let closing = false;
  let attempt = 0;
  let elapsedMs = 0; // cumulative ms already waited across previous EADDRINUSE retries
  let retryTimer: NodeJS.Timeout | undefined;

  let resolveReady: () => void = () => {};
  let rejectReady: (err: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {}); // an unawaited `ready` must never become an unhandled rejection

  function tryListen(): void {
    if (closing) return;
    server.listen(port, '127.0.0.1');
  }

  server.on('listening', () => {
    log(`QB Pipeline relay server listening on http://127.0.0.1:${port}`);
    log(`  Setup page: http://localhost:${port}/setup`);
    resolveReady();
  });

  async function handleAddressInUse(): Promise<void> {
    if (closing) return;
    // Ask on every attempt: a healthy daemon may start while this one is backing off.
    const probe = await probeRelay(port, 1000);
    if (closing) return;
    if (probe.kind === 'daemon') {
      log(`QB Pipeline relay daemon is already running on port ${port} (pid ${probe.info.pid}); not starting another.`);
      rejectReady(new RelayAlreadyRunningError(probe.info));
      return;
    }

    // The port may still be in TIME_WAIT after the previous process exited (common
    // during MCP server restarts in VS Code). Back off and retry up to
    // RETRY_DELAYS_MS.length times before giving up.
    if (attempt >= RETRY_DELAYS_MS.length) {
      log(
        `Warning: QB Pipeline relay port ${port} is still in use after ${attempt} attempts. ` +
        `Pipeline tools will not be available. ` +
        `To fix: set QB_RELAY_PORT to an unused port in your .env file, or stop whatever is using the port.`
      );
      rejectReady(new RelayPortInUseError(port, attempt));
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    attempt++;
    log(`QB Pipeline relay port ${port} busy — retrying in ${delay} ms… (attempt ${attempt}/${RETRY_DELAYS_MS.length}, ${elapsedMs} ms elapsed so far)`);
    elapsedMs += delay;
    server.close();
    retryTimer = setTimeout(tryListen, delay);
    retryTimer.unref();
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      void handleAddressInUse();
      return;
    }
    log(`QB Pipeline relay server error: ${err.message}`);
    rejectReady(err);
  });

  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    if (retryTimer) clearTimeout(retryTimer);
    control?.shutdown();
    client.shutdown();
    rejectReady(new Error('Relay server closed')); // no effect once ready has settled
    closePromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    return closePromise;
  }

  tryListen();
  return { client, port, ready, close };
}
