/**
 * Command-line behaviour of the relay daemon: argument parsing plus the `stop`
 * and `status` commands. (`start` is in daemon.ts, the entry point.)
 *
 * `stop` goes through the authenticated /relay/stop endpoint, after probing the
 * port to see what is there. It never signals a process, never touches a legacy
 * in-process relay or an unrelated program, and never prints the secret.
 */

import { ControlConnectionError, getControl, postControl } from './controlClient.js';
import { probeRelay } from './probe.js';
import { readSecret, relayStatePaths } from './secret.js';

export type DaemonCommand = 'start' | 'stop' | 'status' | 'help';

export interface DaemonArgs {
  command: DaemonCommand;
  port?: number;
  foreground: boolean;
}

export interface CliContext {
  port: number;
  stateDir: string;
  out: (line: string) => void;
}

const COMMANDS: readonly string[] = ['start', 'stop', 'status', 'help'];

export const USAGE = [
  'Usage: node dist/relay/daemon.js [start|stop|status] [--port N] [--foreground]',
  '',
  '  start     run the shared Pipeline relay daemon (the MCP starts it automatically when needed)',
  '  stop      ask a running daemon to stop (authenticated; never signals a process)',
  '  status    show whether a daemon is running, and its pid, build and connected sessions',
  '',
  '  --port N       relay port (default: QB_RELAY_PORT from the environment or .env, else 3737)',
  '  --foreground   with start: also print the log to this terminal',
].join('\n');

function parsePort(raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port "${raw ?? ''}": expected a whole number from 1 to 65535.`);
  }
  return value;
}

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  let command: DaemonCommand | undefined;
  let port: number | undefined;
  let foreground = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      command = 'help';
    } else if (arg === '--foreground') {
      foreground = true;
    } else if (arg === '--port') {
      port = parsePort(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      port = parsePort(arg.slice('--port='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}".\n${USAGE}`);
    } else if (command !== undefined) {
      throw new Error(`Unexpected argument "${arg}".\n${USAGE}`);
    } else if (COMMANDS.includes(arg)) {
      command = arg as DaemonCommand;
    } else {
      throw new Error(`Unknown command "${arg}".\n${USAGE}`);
    }
  }
  return { command: command ?? 'start', ...(port !== undefined ? { port } : {}), foreground };
}

function describeUptime(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`;
}

export async function showStatus(ctx: CliContext): Promise<number> {
  const { port, out } = ctx;
  const probe = await probeRelay(port);
  const paths = relayStatePaths(ctx.stateDir, port);

  switch (probe.kind) {
    case 'none':
      out(`No relay is running on port ${port}.`);
      return 1;
    case 'foreign':
      out(`Port ${port} is in use by a program that is not a QuickBase relay. Set QB_RELAY_PORT to a free port.`);
      return 1;
    case 'legacy':
      out(
        `An old-build (legacy in-process) relay is listening on port ${port}` +
          `${probe.status.active ? ' with a connected bookmarklet' : ''}. It is not a daemon and is shared with no one. ` +
          `Close the Claude session that owns it, or set QB_RELAY_REPLACE_LEGACY=true so the next new-build session replaces it.`
      );
      return 1;
    case 'daemon': {
      const { info } = probe;
      const status = await getControl({ port, timeoutMs: 2000 }, '/relay/status').catch(() => undefined);
      const details = (status?.body ?? {}) as Record<string, unknown>;
      const lock = (details.lock ?? {}) as { held?: boolean; owner?: string };
      out(`The relay daemon is running on port ${port}.`);
      out(`  pid ${info.pid}, build ${info.buildVersion}, started ${info.startedAt}` +
        (typeof details.uptimeSec === 'number' ? ` (up ${describeUptime(details.uptimeSec)})` : ''));
      out(`  QuickBase realm: ${info.realm}`);
      out(
        `  Browser bookmarklet: ${details.active ? `connected (${String(details.realmUser ?? 'unknown host')})` : 'not connected'}`
      );
      out(
        `  Connected Claude sessions: ${String(details.clients ?? 'unknown')}; ` +
          `requests waiting: ${String(details.queued ?? 'unknown')}; ` +
          `impersonation lock: ${lock.held ? `held by ${lock.owner}` : 'free'}`
      );
      out(`  State directory: ${ctx.stateDir}`);
      out(`  Log file: ${paths.log}`);
      return 0;
    }
  }
}

export async function stopDaemon(ctx: CliContext): Promise<number> {
  const { port, out } = ctx;
  const probe = await probeRelay(port);
  const paths = relayStatePaths(ctx.stateDir, port);

  if (probe.kind === 'none') {
    out(`No relay is running on port ${port}; nothing to stop.`);
    return 0;
  }
  if (probe.kind === 'foreign') {
    out(`Port ${port} is in use by a program that is not a QuickBase relay; leaving it alone.`);
    return 1;
  }
  if (probe.kind === 'legacy') {
    out(
      `An old-build (legacy in-process) relay is on port ${port}. It is not a daemon and cannot be stopped from here; ` +
        `close the Claude session that owns it.`
    );
    return 1;
  }

  let secret: string | null;
  try {
    secret = readSecret(ctx.stateDir);
  } catch (err) {
    out(`The relay secret file ${paths.secret} cannot be used: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!secret) {
    out(
      `A relay daemon is running on port ${port}, but this user has no relay secret file (${paths.secret}), ` +
        `so it cannot be stopped from here. It was probably started by another user or with another state directory.`
    );
    return 1;
  }

  let response;
  try {
    response = await postControl({ port, secret, timeoutMs: 5000 }, '/relay/stop', {});
  } catch (err) {
    out(`Could not reach the relay daemon on port ${port}: ${err instanceof ControlConnectionError ? err.message : String(err)}`);
    return 1;
  }
  if (response.status === 401) {
    out(`The relay daemon on port ${port} rejected this user's secret, so it was not stopped.`);
    return 1;
  }
  if (response.status !== 200) {
    out(`The relay daemon on port ${port} did not accept the stop request (HTTP ${response.status}).`);
    return 1;
  }

  // The daemon answers first and closes just after; give it a moment so "stopped" is true when we say it.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await probeRelay(port, 500)).kind !== 'none') {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  out(`Stopped the relay daemon on port ${port} (pid ${probe.info.pid}).`);
  return 0;
}
