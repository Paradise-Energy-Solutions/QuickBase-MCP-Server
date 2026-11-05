/**
 * Process runtime of the shared relay daemon: state files, rotating log, idle
 * exit and a clean stop. The relay logic itself lives in server.ts/control.ts;
 * daemon.ts is the thin entry point that wires this to the command line.
 *
 * State lives in the per-user directory (see secret.ts): the shared secret, a
 * pid file and a log file per port. The pid file is advisory (a human aid and
 * a stale-file hint); whether a daemon is alive is always decided by probing
 * its port, never by pid.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonSettings } from './config.js';
import { relayStatePaths, ensureSecret } from './secret.js';
import type { RelayStatePaths } from './secret.js';
import { startRelayServer } from './server.js';
import type { RelayServer } from './server.js';
import { RELAY_PROTOCOL_VERSION } from './types.js';
import type { RelayInfo } from './types.js';

const DEFAULT_MAX_LOG_BYTES = 1_048_576; // 1 MiB, then rotate to <log>.old

export interface BuildInfo {
  buildVersion: string;
  buildTime: string;
}

export interface DaemonOptions {
  settings: DaemonSettings;
  build: BuildInfo;
  /** Also write log lines to stderr (foreground use). */
  echo?: boolean;
  maxLogBytes?: number;
}

export interface DaemonHandle {
  readonly info: RelayInfo;
  readonly paths: RelayStatePaths;
  readonly server: RelayServer;
  /** Appends a line to the daemon's log (never throws). */
  readonly log: (line: string) => void;
  /** Resolves with the reason once the daemon has fully stopped. */
  readonly stopped: Promise<string>;
  /** Stops the daemon. Idempotent: later calls keep the first reason. */
  stop(reason: string): Promise<void>;
}

/**
 * Appends timestamped lines to `file`, rotating it to `<file>.old` when it would
 * exceed `maxBytes`. Newlines inside a message are flattened so one entry can
 * never forge another. Logging never throws: a relay that cannot write its log
 * must keep relaying.
 */
export function createRotatingLogger(file: string, maxBytes: number, echo = false): (line: string) => void {
  return (line: string): void => {
    const text = `${new Date().toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`;
    if (echo) process.stderr.write(text);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) > maxBytes) {
        fs.rmSync(`${file}.old`, { force: true });
        fs.renameSync(file, `${file}.old`);
      }
      fs.appendFileSync(file, text);
    } catch {
      /* logging must never break the relay */
    }
  };
}

/**
 * Identifies a relay build: the package version plus a short content hash of the
 * compiled relay files, and the newest file time. Two builds with the same
 * protocol version are ordered by build time, which is how a newer MCP knows a
 * running daemon is older.
 */
export function computeBuildInfo(dir: string, packageVersion: string): BuildInfo {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort();
  } catch {
    /* a missing directory is an empty build */
  }
  const hash = createHash('sha256');
  let newest = 0;
  let counted = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      hash.update(name);
      hash.update(fs.readFileSync(file));
      newest = Math.max(newest, Math.round(fs.statSync(file).mtimeMs));
      counted++;
    } catch {
      /* a file that vanished mid-scan is ignored */
    }
  }
  return {
    buildVersion: `${packageVersion}+${counted > 0 ? hash.digest('hex').slice(0, 8) : '00000000'}`,
    buildTime: new Date(newest).toISOString(),
  };
}

function removePidFileIfOurs(file: string): void {
  try {
    const recorded = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
    if (recorded.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    /* no pid file, or not ours to remove */
  }
}

function describeDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round((ms / 60_000) * 10) / 10} min` : `${Math.round(ms / 100) / 10} s`;
}

/**
 * Starts the daemon. Rejects with RelayAlreadyRunningError when a healthy daemon
 * already holds the port (the caller exits quietly: it lost a harmless race) and
 * with RelayPortInUseError when something else keeps the port.
 */
export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { settings, build } = options;
  const paths = relayStatePaths(settings.stateDir, settings.port);
  const secret = ensureSecret(settings.stateDir);
  const log = createRotatingLogger(paths.log, options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES, options.echo);
  const startedAt = new Date().toISOString();
  const info: RelayInfo = {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    buildVersion: build.buildVersion,
    buildTime: build.buildTime,
    pid: process.pid,
    startedAt,
    realm: settings.realm,
  };

  let lastActivity = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  let resolveStopped: (reason: string) => void = () => {};
  const stopped = new Promise<string>((resolve) => {
    resolveStopped = resolve;
  });

  // eslint-disable-next-line prefer-const -- assigned below; the closures only run after that
  let server: RelayServer;

  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log(`stopping: ${reason}`);
      if (idleTimer) clearTimeout(idleTimer);
      await server.close();
      removePidFileIfOurs(paths.pid);
      log('stopped');
      resolveStopped(reason);
    })();
    return stopping;
  };

  server = startRelayServer(settings.realm, settings.port, {
    log,
    onActivity: () => {
      lastActivity = Date.now();
    },
    control: {
      secret,
      info,
      lockTtlMs: settings.lockTtlMs,
      lockWaitMs: settings.lockWaitMs,
      onStop: (reason) => void stop(reason),
    },
  });

  try {
    await server.ready;
  } catch (err) {
    await server.close();
    throw err;
  }

  fs.writeFileSync(
    paths.pid,
    JSON.stringify({ pid: process.pid, port: settings.port, startedAt, buildVersion: build.buildVersion }),
    { mode: 0o600 }
  );
  log(
    `daemon started: pid ${process.pid}, port ${settings.port}, build ${build.buildVersion}, ` +
      `idle exit ${settings.idleMs > 0 ? `after ${describeDuration(settings.idleMs)}` : 'disabled'}`
  );

  if (settings.idleMs > 0) {
    const arm = (delayMs: number): void => {
      idleTimer = setTimeout(check, delayMs);
      idleTimer.unref?.();
    };
    const check = (): void => {
      // A connected bookmarklet is activity in itself.
      if (server.client.isActive) lastActivity = Date.now();
      const idleFor = Date.now() - lastActivity;
      if (idleFor >= settings.idleMs) {
        void stop(`idle for ${describeDuration(settings.idleMs)}`);
        return;
      }
      arm(settings.idleMs - idleFor);
    };
    arm(settings.idleMs);
  }

  return { info, paths, server, log, stopped, stop };
}
