/**
 * ensureRelayDaemon: make sure a compatible relay daemon is serving this user's
 * port, starting one if needed. The MCP server calls it lazily (never blocking
 * its own startup) through RemoteRelayClient.
 *
 * What it does with whatever is on the port:
 *   nothing            spawn the daemon detached and wait until it answers
 *   a compatible daemon  use it
 *   an older daemon    replace it only if that interrupts nobody (no bookmarklet
 *                      connected, nothing queued, no impersonation), through the
 *                      authenticated stop; otherwise keep it (same protocol) or
 *                      explain (older protocol), naming pid and build
 *   a newer daemon     explain; this MCP must be updated, nothing is stopped
 *   a legacy relay     an old-build in-process relay: replaced through its old
 *                      shutdown request when inactive, or when the user opted in
 *                      with QB_RELAY_REPLACE_LEGACY; an active one is never killed
 *                      by surprise
 *   anything else      explain which port and setting to change
 *
 * Simultaneous starts are arbitrated by a spawn lock file; the port bind is the
 * final arbiter (a losing daemon sees a healthy one and exits quietly).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { relayEnvForSpawn } from './config.js';
import { ControlConnectionError, postControl } from './controlClient.js';
import type { BuildInfo } from './daemonRuntime.js';
import { probeRelay } from './probe.js';
import type { RelayProbe } from './probe.js';
import type { EnsureOutcome } from './remote.js';
import { ensureSecret, relayStatePaths } from './secret.js';
import { RELAY_PROTOCOL_VERSION } from './types.js';
import type { RelayInfo } from './types.js';

const DEFAULT_READY_TIMEOUT_MS = 8_000;
const DEFAULT_SPAWN_LOCK_STALE_MS = 15_000;
const POLL_MS = 100;

export interface SpawnedChild {
  unref(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean; env: NodeJS.ProcessEnv }
) => SpawnedChild;

export interface LauncherOptions {
  port: number;
  /** The QuickBase host this MCP serves; a daemon for another realm is refused. */
  realm: string;
  stateDir: string;
  /** Absolute path of the compiled daemon entry (dist/relay/daemon.js). */
  daemonPath: string;
  /** This MCP's relay build, for comparing against a running daemon. */
  build: BuildInfo;
  protocolVersion?: number;
  env?: NodeJS.ProcessEnv;
  /** QB_RELAY_REPLACE_LEGACY: allow replacing an active legacy in-process relay. */
  replaceLegacy?: boolean;
  readyTimeoutMs?: number;
  spawnLockStaleMs?: number;
  log?: (line: string) => void;
  // Injectable for tests:
  spawn?: SpawnFn;
  probe?: (port: number, timeoutMs?: number) => Promise<RelayProbe>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isOlderBuild(info: RelayInfo, mine: BuildInfo): boolean {
  // Same content hash = same build, however recently its files were rewritten (a rebuild
  // refreshes every mtime): never replace a daemon with an identical copy of itself.
  if (info.buildVersion === mine.buildVersion) return false;
  const theirs = Date.parse(info.buildTime);
  const ours = Date.parse(mine.buildTime);
  return Number.isFinite(theirs) && Number.isFinite(ours) && theirs < ours;
}

export async function ensureRelayDaemon(opts: LauncherOptions): Promise<EnsureOutcome> {
  const probe = (opts.probe ?? probeRelay)(opts.port);
  const found = await probe;
  switch (found.kind) {
    case 'daemon':
      return useExisting(opts, found.info);
    case 'none':
      return startNew(opts);
    case 'legacy':
      return replaceLegacy(opts, found.status);
    case 'foreign':
      throw new Error(
        `Port ${opts.port} is in use by a program that is not the QuickBase relay. ` +
          `Set QB_RELAY_PORT to a free port in your .env file and restart this Claude session, or stop whatever is using the port.`
      );
  }
}

async function useExisting(opts: LauncherOptions, info: RelayInfo): Promise<EnsureOutcome> {
  const { port } = opts;
  const mine = opts.protocolVersion ?? RELAY_PROTOCOL_VERSION;
  const log = opts.log ?? (() => {});
  const describe = `pid ${info.pid}, build ${info.buildVersion}, protocol ${info.protocolVersion}`;

  if (info.realm !== opts.realm) {
    throw new Error(
      `A relay daemon for a different QuickBase realm (${info.realm}; ${describe}) is already running on port ${port}. ` +
        `Set QB_RELAY_PORT to a free port for ${opts.realm} in your .env file and restart this Claude session, or stop that daemon with: npm run relay:stop`
    );
  }
  if (info.protocolVersion > mine) {
    throw new Error(
      `The relay daemon running on port ${port} (${describe}) is newer than this MCP build (protocol ${mine}). ` +
        `Rebuild and restart this Claude session (npm run build), or stop the daemon with: npm run relay:stop`
    );
  }

  const older = info.protocolVersion < mine || isOlderBuild(info, opts.build);
  if (!older) return { started: false };

  // An older daemon: replace it, but only when that interrupts nobody.
  const replaced = await tryReplace(opts, info);
  if (replaced === 'busy') {
    if (info.protocolVersion === mine) {
      log(`relay daemon (${describe}) is an older build but busy; keeping it`);
      return { started: false };
    }
    throw new Error(
      `The relay daemon running on port ${port} (${describe}) is older than this MCP build (protocol ${mine}) and is busy ` +
        `(a bookmarklet is connected or an impersonation is active), so it was not replaced. ` +
        `Restart it when convenient with: npm run relay:stop (the open Pipelines tab then reconnects to the new one by itself).`
    );
  }
  log(`replaced the older relay daemon (${describe})`);
  return startNew(opts);
}

async function tryReplace(opts: LauncherOptions, info: RelayInfo): Promise<'replaced' | 'busy'> {
  const secret = ensureSecret(opts.stateDir);
  let response;
  try {
    response = await postControl({ port: opts.port, secret, timeoutMs: 5000 }, '/relay/stop', { ifIdle: true });
  } catch (err) {
    // Only a refused connection proves it went away on its own; a reset or timeout may be a live daemon.
    if (err instanceof ControlConnectionError && err.refused) return 'replaced';
    throw err;
  }
  if (response.status === 401) {
    throw new Error(
      `The relay daemon on port ${opts.port} (pid ${info.pid}) rejected this user's secret, so it cannot be replaced. ` +
        `If another user or another state directory started it, stop it there, or set QB_RELAY_PORT to a different port.`
    );
  }
  if (response.status === 409) return 'busy';
  if (response.status !== 200) {
    throw new Error(`The relay daemon on port ${opts.port} (pid ${info.pid}) refused to be replaced (HTTP ${response.status}).`);
  }
  await waitForPortFree(opts, `The old relay daemon (pid ${info.pid}) did not release port ${opts.port} in time.`);
  return 'replaced';
}

async function replaceLegacy(opts: LauncherOptions, status: { active: boolean; realmUser: string | null }): Promise<EnsureOutcome> {
  const { port } = opts;
  if (status.active && !opts.replaceLegacy) {
    throw new Error(
      `An old-build (in-process) relay holds port ${port} and has a bookmarklet connected (${status.realmUser ?? 'unknown host'}), ` +
        `so Pipeline tools in this session are unavailable until it is replaced. Either close the Claude session(s) running the old build, ` +
        `or set QB_RELAY_REPLACE_LEGACY=true in your .env file once and restart this session: it will then take over the port ` +
        `(the open Pipelines tab reconnects by itself; sessions still on the old build lose their pipeline tools, as they already do whenever a newer session starts).`
    );
  }
  await requestLegacyShutdown(port);
  await waitForPortFree(
    opts,
    `The old-build relay on port ${port} did not release the port after a shutdown request. Close the Claude session that owns it, or set QB_RELAY_PORT to a free port.`
  );
  (opts.log ?? (() => {}))(`replaced a legacy in-process relay on port ${port}`);
  return startNew(opts);
}

/** The old relay's own shutdown request (it has no authenticated stop); errors are ignored, the port wait decides. */
function requestLegacyShutdown(port: number): Promise<void> {
  return new Promise((resolve) => {
    const body = '{}';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/relay/shutdown',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        agent: false,
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve());
    req.end(body);
  });
}

async function waitForPortFree(opts: LauncherOptions, failure: string): Promise<void> {
  const probe = opts.probe ?? probeRelay;
  const deadline = Date.now() + (opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  while ((await probe(opts.port, 500)).kind !== 'none') {
    if (Date.now() >= deadline) throw new Error(failure);
    await sleep(POLL_MS);
  }
}

/** True when this caller created the lock (and so spawns); false when a fresh lock belongs to another starter. */
function acquireSpawnLock(file: string, staleMs: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > staleMs) {
          fs.rmSync(file, { force: true }); // left by a starter that died
          continue;
        }
      } catch {
        continue; // it vanished between the two calls: try again
      }
      return false;
    }
  }
  return false;
}

async function startNew(opts: LauncherOptions): Promise<EnsureOutcome> {
  const paths = relayStatePaths(opts.stateDir, opts.port);
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const ownsLock = acquireSpawnLock(paths.spawnLock, opts.spawnLockStaleMs ?? DEFAULT_SPAWN_LOCK_STALE_MS);
  let spawnError: Error | undefined;

  try {
    if (ownsLock) {
      const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
      const child = spawn(process.execPath, [opts.daemonPath, 'start'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // Relay settings and OS essentials only: the daemon never receives QB_USER_TOKEN or the app registry.
        env: relayEnvForSpawn({
          ...(opts.env ?? process.env),
          QB_REALM: opts.realm,
          QB_RELAY_PORT: String(opts.port),
          QB_RELAY_STATE_DIR: opts.stateDir,
        }),
      });
      child.on('error', (err) => {
        spawnError = err;
      });
      child.unref();
    }

    const probe = opts.probe ?? probeRelay;
    const deadline = Date.now() + (opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    for (;;) {
      if (spawnError) throw new Error(`Could not start the relay daemon: ${spawnError.message}`);
      const found = await probe(opts.port, 500);
      if (found.kind === 'daemon') {
        verifyStarted(opts, found.info);
        return { started: true };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The relay daemon did not become ready within ${Math.round((opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000)} s. ` +
            `See its log: ${paths.log}`
        );
      }
      await sleep(POLL_MS);
    }
  } finally {
    if (ownsLock) fs.rmSync(paths.spawnLock, { force: true });
  }
}

/** A daemon came up on the port: make sure it is one this MCP can use. */
function verifyStarted(opts: LauncherOptions, info: RelayInfo): void {
  const mine = opts.protocolVersion ?? RELAY_PROTOCOL_VERSION;
  if (info.realm !== opts.realm) {
    throw new Error(
      `A relay daemon for a different QuickBase realm (${info.realm}; pid ${info.pid}) answered on port ${opts.port}. ` +
        `Set QB_RELAY_PORT to a free port for ${opts.realm}.`
    );
  }
  if (info.protocolVersion > mine) {
    throw new Error(
      `The relay daemon that started on port ${opts.port} (pid ${info.pid}, build ${info.buildVersion}) is newer than this MCP build. Rebuild and restart this Claude session.`
    );
  }
}
