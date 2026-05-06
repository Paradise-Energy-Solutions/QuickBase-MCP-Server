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
 * domain — no external access, no SSRF risk.
 */

import http from 'node:http';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

export interface RelayRequest {
  id: string;
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface RelayResult {
  status: number;
  data: unknown;
  error?: string;
}

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
const MAX_BODY_BYTES = 1_048_576; // 1 MB — protect against runaway payloads
const RETRY_DELAYS_MS = [500, 500, 1000, 1000, 2000]; // EADDRINUSE backoff — ~5 s total

export class RelayClient {
  private pending: Map<string, PendingEntry> = new Map();
  private queue: RelayRequest[] = [];
  private longPollRes: http.ServerResponse | null = null;
  private helloState: HelloState | null = null;
  private port: number;

  constructor(port: number) {
    this.port = port;
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
    extraHeaders?: Record<string, string>
  ): Promise<RelayResult> {
    if (!this.isActive) {
      throw new McpError(
        ErrorCode.InternalError,
        this.notActiveMessage()
      );
    }

    const req: RelayRequest = { id: randomUUID(), path, method, body, headers: extraHeaders };

    return new Promise<RelayResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new McpError(
          ErrorCode.InternalError,
          this.timeoutMessage()
        ));
      }, REQUEST_TIMEOUT_MS);
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
    ].join('\n');
  }

  private timeoutMessage(): string {
    return [
      'The QuickBase Pipeline relay timed out.',
      '',
      'The browser tab running the relay may have been closed, navigated away, or gone idle.',
      'Navigate to the QuickBase Pipelines dashboard and click the "QB Pipeline Relay" bookmarklet to reconnect, then retry this tool.',
      '(The bookmarklet only works from the Pipelines dashboard page, not other QuickBase pages.)',
      `Setup page: http://localhost:${this.port}/setup`,
    ].join('\n');
  }

  /**
   * Gracefully tear down the relay: reject pending tool requests and close any
   * open long-poll connection. Called when another relay instance signals this
   * server to shut down via POST /relay/shutdown.
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
      entry.reject(new McpError(ErrorCode.InternalError, 'Relay server shutting down'));
    }
    this.pending.clear();
  }
}

function buildSetupPage(realm: string, port: number): string {
  // Validate realm before interpolating into HTML to prevent latent XSS if
  // the value ever flows from a less-trusted config source.
  const safeRealm = realm.replace(/[^a-zA-Z0-9.-]/g, '');
  const pipelinesBase = `https://${safeRealm.replace('quickbase.com', 'pipelines.quickbase.com')}`;
  const relayBase = `http://localhost:${port}`;

  // Bookmarklet source — minified inline JS
  // Uses window.PIPELINES_PAGE_TOKEN (QB sets this on every page) as the CSRF token.
  const bookmarkletSrc = `(function(){
var B='${relayBase}';
var PL='${pipelinesBase}';
var T=window['PIPELINES_PAGE_TOKEN'];
if(!T){alert('QB Pipeline Relay: Could not find PIPELINES_PAGE_TOKEN.\\n\\nNavigate to the Pipelines dashboard first:\\nhttps://'+location.hostname+'/nav/main/action/pipelines/dashboard');return;}
if(window['_qbRelayIv']){clearInterval(window['_qbRelayIv']);}
window['_qbRelayGen']=(window['_qbRelayGen']||0)+1;
var gen=window['_qbRelayGen'];
var lastPoll=0;
function hello(){T=window['PIPELINES_PAGE_TOKEN']||T;fetch(B+'/relay/hello',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrfToken:T,realm:location.hostname})}).catch(function(){});}
hello();
window['_qbRelayIv']=setInterval(function(){hello();if(Date.now()-lastPoll>35000)poll();},240000);
function poll(){
if(window['_qbRelayGen']!==gen)return;
lastPoll=Date.now();
fetch(B+'/relay/pending').then(function(r){return r.status===200?r.json():null;}).then(function(req){
if(!req){setTimeout(poll,2000);return;}
var opts={method:req.method||'GET',credentials:'include',headers:Object.assign({'X-CSRFToken':T,'Accept':'application/json'},req.headers||{})};
if(req.body&&req.method!=='GET'){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(req.body);}
fetch(PL+req.path,opts).then(function(r){return r.json().then(function(d){return{status:r.status,data:d};});}).then(function(result){
return fetch(B+'/relay/result/'+req.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
}).then(poll).catch(function(e){
fetch(B+'/relay/result/'+req.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:0,data:null,error:e.message})}).catch(function(){}).then(poll);
});
}).catch(function(){setTimeout(poll,5000);});
}
poll();
alert('\\u2705 QB Pipeline Relay active!');
})();`;

  const encoded = `javascript:${encodeURIComponent(bookmarkletSrc)}`;

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
    <p>The bookmarklet automatically sends a keepalive every 4 minutes and will restart the polling loop if it stalls, so it should stay active indefinitely while the Pipelines tab is open. If you do need to reconnect (e.g. after closing the tab), return to the <a href="https://${safeRealm}/nav/main/action/pipelines/dashboard" target="_blank">Pipelines dashboard</a> and click the bookmarklet again.</p>
  </div>
</div>

<div class="status-bar" id="status">Checking relay status&hellip;</div>

<script>
fetch('/relay/status').then(r=>r.json()).then(d=>{
  const el=document.getElementById('status');
  if(d.active){el.style.background='#e6f4ea';el.style.color='#1e7e34';el.innerHTML='&#10003; <span>Relay is active.</span> Pipeline tools are ready.';}
  else{el.innerHTML='&#9888; <span>Relay is not yet active.</span> Follow steps 2 and 3 above.';}
}).catch(()=>{});
</script>
</body>
</html>`;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
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

function cors(res: http.ServerResponse, allowedOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Returns true when the request origin is acceptable:
 *  - No Origin header  → same-process HTTP request (node:http.request), always allowed.
 *  - Origin matches the QB realm → bookmarklet running on the QB domain, allowed.
 *  - Any other origin  → cross-site request, denied.
 *
 * This guards endpoints that mutate server state (/relay/shutdown, /relay/result)
 * against cross-site requests that bypass CORS preflight (e.g. form POSTs with
 * application/x-www-form-urlencoded).
 */
function isOriginAllowed(origin: string | undefined, allowedOrigin: string): boolean {
  if (origin === undefined || origin === '') return true; // same-process call
  return origin === allowedOrigin;
}

export function startRelayServer(realm: string, port: number): RelayClient {
  const client = new RelayClient(port);
  const allowedOrigin = `https://${realm}`;

  const server = http.createServer(async (req, res) => {
    cors(res, allowedOrigin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = req.url ?? '/';

    // ── GET /setup ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/setup') {
      const html = buildSetupPage(realm, port);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ── GET /relay/status ────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/relay/status') {
      const body = JSON.stringify({ active: client.isActive, realmUser: client.currentUser });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    // ── POST /relay/shutdown ─────────────────────────────────────────────────
    // Called by a new relay instance to ask this server to release the port
    // gracefully. POST-only + explicit Origin check prevents CSRF from arbitrary
    // web pages: a same-process shutdown (no Origin header) is always accepted;
    // a cross-site request carrying a non-QB Origin is rejected with 403.
    if (req.method === 'POST' && url === '/relay/shutdown') {
      const origin = req.headers.origin as string | undefined;
      if (!isOriginAllowed(origin, allowedOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      client.shutdown();
      setImmediate(() => server.close());
      console.error('QB Pipeline relay server: received shutdown signal — closing to allow restart.');
      return;
    }

    // ── GET /relay/pending ────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/relay/pending') {
      client.registerLongPoll(res);
      return;
    }

    // ── POST /relay/hello ─────────────────────────────────────────────────────
    if (req.method === 'POST' && url === '/relay/hello') {
      try {
        const body = await readBody(req) as { csrfToken: string; realm: string };
        if (body?.csrfToken && body?.realm) {
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
      const origin = req.headers.origin as string | undefined;
      if (!isOriginAllowed(origin, allowedOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      try {
        const result = await readBody(req) as RelayResult;
        client.receiveResult(resultMatch[1], result);
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
      return;
    }

    res.writeHead(404).end();
  });

  let attempt = 0;

  function tryListen(): void {
    server.listen(port, '127.0.0.1', () => {
      console.error(`QB Pipeline relay server listening on http://127.0.0.1:${port}`);
      console.error(`  Setup page: http://localhost:${port}/setup`);
    });
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Port may still be in TIME_WAIT after the previous process was killed
      // (common during MCP server restarts in VS Code). Back off and retry up
      // to RETRY_DELAYS_MS.length times before giving up.
      if (attempt >= RETRY_DELAYS_MS.length) {
        console.error(
          `Warning: QB Pipeline relay port ${port} is still in use after ${attempt} attempts. ` +
          `Pipeline tools will not be available. ` +
          `To fix: set QB_RELAY_PORT to an unused port in your .env file, or wait a moment and restart the server.`
        );
      } else {
        const delay = RETRY_DELAYS_MS[attempt];
        attempt++;
        // elapsed = time already waited across previous retries (not including
        // the current delay which hasn't started yet).
        const elapsed = RETRY_DELAYS_MS.slice(0, attempt - 1).reduce((a, b) => a + b, 0);
        console.error(`QB Pipeline relay port ${port} busy — retrying in ${delay} ms… (attempt ${attempt}/${RETRY_DELAYS_MS.length}, ${elapsed} ms elapsed so far)`);
        // On the first attempt, ask the existing relay server to shut down so
        // the port is released sooner than its natural process-exit.
        if (attempt === 1) {
          const shutdownReq = http.request(
            { host: '127.0.0.1', port, path: '/relay/shutdown', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
              timeout: 1000 },
            (r) => { r.resume(); }
          );
          shutdownReq.on('error', () => {}); // non-QB process on this port — ignore
          shutdownReq.end('{}');
        }
        server.close();
        setTimeout(tryListen, delay).unref();
      }
    } else {
      console.error(`QB Pipeline relay server error: ${err.message}`);
    }
  });

  tryListen();
  return client;
}
