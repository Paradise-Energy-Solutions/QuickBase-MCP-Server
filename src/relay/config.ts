/**
 * Settings for the relay daemon, read from environment variables, plus the
 * allowlist of variables a spawned daemon inherits.
 *
 * The daemon needs only the realm host name (to restrict CORS and build the
 * bookmarklet) and its own settings; it never needs the QuickBase user token,
 * app registry or any other credential, so none of those is passed to it.
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import { resolveStateDir } from './secret.js';

export const DEFAULT_RELAY_PORT = 3737;
const DEFAULT_IDLE_MINUTES = 60;
const DEFAULT_LOCK_TTL_SECONDS = 300;
const DEFAULT_LOCK_WAIT_SECONDS = 20;
const REALM_PATTERN = /^[A-Za-z0-9.-]+$/;

/** The only .env keys the daemon reads. */
export const RELAY_ENV_KEYS = [
  'QB_REALM',
  'QB_RELAY_PORT',
  'QB_RELAY_IDLE_MINUTES',
  'QB_RELAY_STATE_DIR',
  'QB_RELAY_LOCK_TTL_SECONDS',
  'QB_RELAY_LOCK_WAIT_SECONDS',
] as const;

/** Operating-system variables node needs to start and find its state directory. */
export const OS_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'LOCALAPPDATA',
  'APPDATA',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_STATE_HOME',
  'LANG',
] as const;

export interface DaemonSettings {
  realm: string;
  port: number;
  stateDir: string;
  /** 0 disables the idle exit. */
  idleMs: number;
  lockTtlMs: number;
  lockWaitMs: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function port(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RELAY_PORT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : DEFAULT_RELAY_PORT;
}

/** The relay port from QB_RELAY_PORT (default 3737); also what `stop` and `status` act on. */
export function relayPortFromEnv(env: NodeJS.ProcessEnv): number {
  return port(env.QB_RELAY_PORT);
}

function idleMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_MINUTES;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_MINUTES; // 0 means "never"
}

export function daemonSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): DaemonSettings {
  const realm = (env.QB_REALM ?? '').trim();
  if (!realm || !REALM_PATTERN.test(realm)) {
    throw new Error('QB_REALM must be set to your QuickBase host name (for example "myorg.quickbase.com").');
  }
  return {
    realm,
    port: port(env.QB_RELAY_PORT),
    stateDir: resolveStateDir(env, platform, home),
    idleMs: Math.round(idleMinutes(env.QB_RELAY_IDLE_MINUTES) * 60_000),
    lockTtlMs: Math.round(positiveNumber(env.QB_RELAY_LOCK_TTL_SECONDS, DEFAULT_LOCK_TTL_SECONDS) * 1000),
    lockWaitMs: Math.round(positiveNumber(env.QB_RELAY_LOCK_WAIT_SECONDS, DEFAULT_LOCK_WAIT_SECONDS) * 1000),
  };
}

/** The environment a spawned daemon receives: relay settings and OS essentials only. */
export function relayEnvForSpawn(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [...RELAY_ENV_KEYS, ...OS_ENV_KEYS]) {
    const value = env[key];
    if (value !== undefined && value !== '') result[key] = value;
  }
  return result;
}

/**
 * For a manual start (`npm run relay:start`): read the first existing .env among
 * `candidates` and copy only the relay keys into `env`, never overriding a value
 * already set. Unlike a plain dotenv load, QB_USER_TOKEN and the app registry
 * never enter the daemon's environment. Returns the file used, if any.
 */
export function loadRelayEnvFile(candidates: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const file of candidates) {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch {
      continue;
    }
    const parsed = dotenv.parse(content);
    for (const key of RELAY_ENV_KEYS) {
      if (env[key] === undefined && parsed[key] !== undefined) env[key] = parsed[key];
    }
    return file;
  }
  return undefined;
}
