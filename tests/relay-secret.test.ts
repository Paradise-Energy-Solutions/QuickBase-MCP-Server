import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveStateDir,
  relayStatePaths,
  ensureSecret,
  readSecret,
  secretsMatch,
} from '../src/relay/secret';

const itPosix = process.platform === 'win32' ? it.skip : it;

describe('resolveStateDir', () => {
  it('honours QB_RELAY_STATE_DIR on every platform', () => {
    const dir = path.resolve(os.tmpdir(), 'qb-relay-explicit');
    expect(resolveStateDir({ QB_RELAY_STATE_DIR: dir }, 'win32', 'C:\\Users\\a')).toBe(dir);
    expect(resolveStateDir({ QB_RELAY_STATE_DIR: dir }, 'linux', '/home/a')).toBe(dir);
  });

  it('uses %LOCALAPPDATA%\\quickbase-mcp on Windows', () => {
    expect(
      resolveStateDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'),
    ).toBe('C:\\Users\\a\\AppData\\Local\\quickbase-mcp');
  });

  it('falls back to <home>\\AppData\\Local\\quickbase-mcp on Windows when LOCALAPPDATA is unset', () => {
    expect(resolveStateDir({}, 'win32', 'C:\\Users\\a')).toBe(
      'C:\\Users\\a\\AppData\\Local\\quickbase-mcp',
    );
  });

  it('uses $XDG_STATE_HOME/quickbase-mcp on POSIX when set', () => {
    expect(resolveStateDir({ XDG_STATE_HOME: '/x/state' }, 'linux', '/home/a')).toBe(
      '/x/state/quickbase-mcp',
    );
  });

  it('falls back to ~/.local/state/quickbase-mcp on POSIX', () => {
    expect(resolveStateDir({}, 'linux', '/home/a')).toBe('/home/a/.local/state/quickbase-mcp');
    expect(resolveStateDir({}, 'darwin', '/Users/a')).toBe('/Users/a/.local/state/quickbase-mcp');
  });

  it('ignores blank or whitespace-only overrides', () => {
    expect(
      resolveStateDir({ QB_RELAY_STATE_DIR: '   ', XDG_STATE_HOME: '' }, 'linux', '/home/a'),
    ).toBe('/home/a/.local/state/quickbase-mcp');
    expect(
      resolveStateDir({ QB_RELAY_STATE_DIR: '', LOCALAPPDATA: '  ' }, 'win32', 'C:\\Users\\a'),
    ).toBe('C:\\Users\\a\\AppData\\Local\\quickbase-mcp');
  });
});

describe('relayStatePaths', () => {
  it('scopes pid, log and spawn-lock files by port and shares one secret file', () => {
    const dir = path.resolve(os.tmpdir(), 'qb-relay-paths');
    const p3737 = relayStatePaths(dir, 3737);
    const p3799 = relayStatePaths(dir, 3799);

    expect(path.basename(p3737.secret)).toBe('relay.secret');
    expect(p3737.secret).toBe(p3799.secret);
    expect(path.basename(p3737.pid)).toBe('relay.3737.pid');
    expect(path.basename(p3799.pid)).toBe('relay.3799.pid');
    expect(path.basename(p3737.log)).toBe('relay.3737.log');
    expect(path.basename(p3737.spawnLock)).toBe('relay.3737.spawn.lock');
    for (const file of [p3737.secret, p3737.pid, p3737.log, p3737.spawnLock]) {
      expect(path.dirname(file)).toBe(dir);
    }
  });
});

describe('ensureSecret / readSecret', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-relay-test-secret-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the state directory and a 64-hex-character secret', () => {
    const stateDir = path.join(dir, 'nested', 'quickbase-mcp');
    const secret = ensureSecret(stateDir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(stateDir, 'relay.secret'), 'utf8').trim()).toBe(secret);
  });

  it('is idempotent: later calls return the same secret and never overwrite it', () => {
    const first = ensureSecret(dir);
    const second = ensureSecret(dir);
    expect(second).toBe(first);
    expect(readSecret(dir)).toBe(first);
  });

  it('readSecret returns null when no secret exists yet', () => {
    expect(readSecret(dir)).toBeNull();
  });

  itPosix('creates the secret file with owner-only mode 0600 and the directory with 0700', () => {
    const stateDir = path.join(dir, 'private');
    ensureSecret(stateDir);
    expect(fs.statSync(path.join(stateDir, 'relay.secret')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it('waits for a concurrent creator that has made the file but not yet written it', () => {
    const file = path.join(dir, 'relay.secret');
    fs.writeFileSync(file, ''); // the other process has opened the file, not yet written
    const winner = 'ab'.repeat(32);
    const sleep = jest.fn(() => {
      fs.writeFileSync(file, winner); // by the time we look again the winner has finished
    });

    expect(ensureSecret(dir, { sleepMs: sleep })).toBe(winner);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up with an error when the file stays empty', () => {
    fs.writeFileSync(path.join(dir, 'relay.secret'), '');
    expect(() => ensureSecret(dir, { sleepMs: () => {}, attempts: 3 })).toThrow(/relay\.secret/);
  });

  it('rejects a corrupt secret without echoing its contents', () => {
    fs.writeFileSync(path.join(dir, 'relay.secret'), 'super-private-nonsense');
    let message = '';
    try {
      ensureSecret(dir, { sleepMs: () => {}, attempts: 1 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('relay.secret');
    expect(message).not.toContain('super-private-nonsense');
  });
});

describe('secretsMatch', () => {
  const secret = 'f'.repeat(64);

  it('accepts the identical secret', () => {
    expect(secretsMatch(secret, secret)).toBe(true);
  });

  it('rejects a different secret of the same length', () => {
    expect(secretsMatch('e'.repeat(64), secret)).toBe(false);
  });

  it('rejects secrets of a different length without throwing', () => {
    expect(secretsMatch('f'.repeat(63), secret)).toBe(false);
    expect(secretsMatch('f'.repeat(65), secret)).toBe(false);
  });

  it('rejects empty, missing and non-string values', () => {
    expect(secretsMatch('', secret)).toBe(false);
    expect(secretsMatch(undefined, secret)).toBe(false);
    expect(secretsMatch(['f'.repeat(64)] as unknown as string, secret)).toBe(false);
    expect(secretsMatch(secret, '')).toBe(false);
  });
});
