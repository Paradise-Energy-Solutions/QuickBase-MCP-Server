/**
 * Per-user state directory and shared secret for the Pipeline relay daemon.
 *
 * The daemon and every MCP instance run as the same OS user and share one
 * secret file. The secret authenticates MCP -> daemon calls (sent as the
 * X-QB-Relay-Secret header) so that no web page and no other local user can
 * drive the relay. It must never be logged, echoed in an error, or returned
 * from an endpoint.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR_NAME = 'quickbase-mcp';
const SECRET_FILE = 'relay.secret';
const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_READ_ATTEMPTS = 50;
const READ_RETRY_DELAY_MS = 10;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Where the daemon keeps its secret, pid, log and spawn-lock files.
 *
 * Precedence: QB_RELAY_STATE_DIR (tests and advanced use), then
 * %LOCALAPPDATA%\quickbase-mcp on Windows, then $XDG_STATE_HOME or
 * ~/.local/state + /quickbase-mcp everywhere else.
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const explicit = nonBlank(env.QB_RELAY_STATE_DIR);
  if (explicit) return path.resolve(explicit);

  if (platform === 'win32') {
    const base = nonBlank(env.LOCALAPPDATA) ?? path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, STATE_DIR_NAME);
  }
  const base = nonBlank(env.XDG_STATE_HOME) ?? path.posix.join(home, '.local', 'state');
  return path.posix.join(base, STATE_DIR_NAME);
}

export interface RelayStatePaths {
  secret: string;
  pid: string;
  log: string;
  spawnLock: string;
}

/** One secret per user; pid, log and spawn-lock files are scoped by port so scratch daemons never collide. */
export function relayStatePaths(stateDir: string, port: number): RelayStatePaths {
  return {
    secret: path.join(stateDir, SECRET_FILE),
    pid: path.join(stateDir, `relay.${port}.pid`),
    log: path.join(stateDir, `relay.${port}.log`),
    spawnLock: path.join(stateDir, `relay.${port}.spawn.lock`),
  };
}

export interface EnsureSecretOptions {
  /** Blocking sleep between reads while another process finishes writing the file. */
  sleepMs?: (ms: number) => void;
  attempts?: number;
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Never include the file contents in the message: it may be (part of) the secret. */
function corruptSecretError(file: string): Error {
  return new Error(
    `Relay secret file ${file} is corrupt (expected 64 hex characters). Delete it and retry; a new secret is created automatically.`,
  );
}

function parseSecret(raw: string, file: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!SECRET_PATTERN.test(value)) throw corruptSecretError(file);
  return value;
}

/**
 * Returns the shared secret, creating it (and the state directory) on first use.
 *
 * Creation is exclusive (`wx`, mode 0600) so two MCP instances starting at the
 * same moment converge on one value: the loser waits briefly for the winner's
 * write to land, then reads it. On POSIX the directory is 0700; on Windows the
 * mode bits are not enforced and owner-only access relies on the inherited ACL
 * of %LOCALAPPDATA%.
 */
export function ensureSecret(stateDir: string, opts: EnsureSecretOptions = {}): string {
  const file = path.join(stateDir, SECRET_FILE);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    const secret = randomBytes(32).toString('hex');
    try {
      fs.writeSync(fd, secret);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    return secret;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const attempts = opts.attempts ?? DEFAULT_READ_ATTEMPTS;
  const sleep = opts.sleepMs ?? blockingSleep;
  for (let i = 0; i < attempts; i++) {
    const secret = parseSecret(fs.readFileSync(file, 'utf8'), file);
    if (secret) return secret;
    if (i < attempts - 1) sleep(READ_RETRY_DELAY_MS);
  }
  throw new Error(
    `Relay secret file ${file} is empty. Another process may still be writing it; if this persists (a crash can leave it empty), delete the file and retry: a new secret is created automatically.`,
  );
}

/** Reads the existing secret without creating one. Null when absent or still empty. */
export function readSecret(stateDir: string): string | null {
  const file = path.join(stateDir, SECRET_FILE);
  try {
    return parseSecret(fs.readFileSync(file, 'utf8'), file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Timing-safe comparison. Both sides are hashed first so the comparison runs
 * over equal-length digests and leaks neither content nor length.
 */
export function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0 || expected.length === 0) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
