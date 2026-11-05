#!/usr/bin/env node
/**
 * Entry point of the shared QuickBase Pipeline relay daemon:
 *
 *   node dist/relay/daemon.js [start|stop|status] [--port N] [--foreground]
 *
 * The MCP server starts this automatically (detached) the first time a Pipeline
 * tool needs it, so most people never run it by hand. This file only wires the
 * command line, environment and OS signals to the testable pieces in
 * daemonCli.ts, daemonRuntime.ts and config.ts. It is excluded from coverage
 * (like src/index.ts) because it is the one place that needs `import.meta`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonSettingsFromEnv, loadRelayEnvFile, relayPortFromEnv } from './config.js';
import { parseDaemonArgs, showStatus, stopDaemon, USAGE } from './daemonCli.js';
import type { DaemonArgs } from './daemonCli.js';
import { computeBuildInfo, startDaemon } from './daemonRuntime.js';
import type { DaemonHandle } from './daemonRuntime.js';
import { RelayAlreadyRunningError } from './errors.js';
import { resolveStateDir } from './secret.js';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<number> {
  let args: DaemonArgs;
  try {
    args = parseDaemonArgs(process.argv.slice(2));
  } catch (err) {
    console.error(message(err));
    return 2;
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, '..', '..');
  // Relay settings only: QB_USER_TOKEN and the app registry in .env never enter this process.
  loadRelayEnvFile([path.resolve(process.cwd(), '.env'), path.join(packageRoot, '.env')]);
  if (args.port !== undefined) process.env.QB_RELAY_PORT = String(args.port);

  if (args.command === 'stop' || args.command === 'status') {
    const ctx = { port: relayPortFromEnv(process.env), stateDir: resolveStateDir(), out: (line: string) => console.log(line) };
    return args.command === 'stop' ? stopDaemon(ctx) : showStatus(ctx);
  }

  let daemon: DaemonHandle;
  try {
    const settings = daemonSettingsFromEnv(process.env);
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version?: string };
    daemon = await startDaemon({
      settings,
      build: computeBuildInfo(here, packageJson.version ?? '0.0.0'),
      echo: args.foreground,
    });
  } catch (err) {
    if (err instanceof RelayAlreadyRunningError) {
      // Lost a harmless race to another daemon start: exit quietly.
      if (args.foreground) console.error(err.message);
      return 0;
    }
    console.error(`Could not start the relay daemon: ${message(err)}`);
    return 1;
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => void daemon.stop(`signal ${signal}`));
  }
  process.on('uncaughtException', (err) => {
    daemon.log(`fatal: ${err.stack ?? err.message}`);
    void daemon.stop('fatal error').finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    daemon.log(`unhandled rejection: ${message(reason)}`);
  });

  await daemon.stopped;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(message(err));
    process.exit(1);
  }
);
