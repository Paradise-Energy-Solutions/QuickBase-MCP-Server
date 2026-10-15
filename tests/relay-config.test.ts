import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OS_ENV_KEYS,
  RELAY_ENV_KEYS,
  daemonSettingsFromEnv,
  loadRelayEnvFile,
  relayEnvForSpawn,
} from '../src/relay/config';

const BASE_ENV = { QB_REALM: 'jane.quickbase.com' };

describe('daemonSettingsFromEnv', () => {
  it('applies the documented defaults', () => {
    const settings = daemonSettingsFromEnv({ ...BASE_ENV, QB_RELAY_STATE_DIR: '/tmp/qb-state' });

    expect(settings).toMatchObject({
      realm: 'jane.quickbase.com',
      port: 3737,
      idleMs: 60 * 60_000,
      lockTtlMs: 300_000,
      lockWaitMs: 20_000,
    });
    expect(settings.stateDir).toBe(path.resolve('/tmp/qb-state'));
  });

  it('reads every override', () => {
    const settings = daemonSettingsFromEnv({
      ...BASE_ENV,
      QB_RELAY_PORT: '3799',
      QB_RELAY_IDLE_MINUTES: '5',
      QB_RELAY_LOCK_TTL_SECONDS: '90',
      QB_RELAY_LOCK_WAIT_SECONDS: '7',
      QB_RELAY_STATE_DIR: '/tmp/qb-state',
    });

    expect(settings).toMatchObject({ port: 3799, idleMs: 300_000, lockTtlMs: 90_000, lockWaitMs: 7_000 });
  });

  it('accepts fractional idle minutes and 0 meaning "never exit when idle"', () => {
    expect(daemonSettingsFromEnv({ ...BASE_ENV, QB_RELAY_IDLE_MINUTES: '0.5' }).idleMs).toBe(30_000);
    expect(daemonSettingsFromEnv({ ...BASE_ENV, QB_RELAY_IDLE_MINUTES: '0' }).idleMs).toBe(0);
  });

  it.each(['', 'abc', '-5', 'NaN', '99999', '0', '3737.5'])('falls back to port 3737 for QB_RELAY_PORT=%j', (value) => {
    expect(daemonSettingsFromEnv({ ...BASE_ENV, QB_RELAY_PORT: value }).port).toBe(3737);
  });

  it.each(['', 'abc', '-1', 'NaN'])('falls back to the default idle time for QB_RELAY_IDLE_MINUTES=%j', (value) => {
    expect(daemonSettingsFromEnv({ ...BASE_ENV, QB_RELAY_IDLE_MINUTES: value }).idleMs).toBe(60 * 60_000);
  });

  it.each(['', 'abc', '0', '-3'])('falls back to the default lock settings for %j', (value) => {
    const settings = daemonSettingsFromEnv({ ...BASE_ENV, QB_RELAY_LOCK_TTL_SECONDS: value, QB_RELAY_LOCK_WAIT_SECONDS: value });
    expect(settings.lockTtlMs).toBe(300_000);
    expect(settings.lockWaitMs).toBe(20_000);
  });

  it('requires QB_REALM', () => {
    expect(() => daemonSettingsFromEnv({})).toThrow(/QB_REALM/);
    expect(() => daemonSettingsFromEnv({ QB_REALM: '   ' })).toThrow(/QB_REALM/);
  });

  it.each(['evil.example/path', 'a b.quickbase.com', 'x.quickbase.com;rm', "x'.quickbase.com", 'https://x.quickbase.com'])(
    'rejects the malformed realm %j',
    (realm) => {
      expect(() => daemonSettingsFromEnv({ QB_REALM: realm })).toThrow(/QB_REALM/);
    },
  );

  it('uses the platform state directory when QB_RELAY_STATE_DIR is unset', () => {
    const settings = daemonSettingsFromEnv(BASE_ENV, 'linux', '/home/a');
    expect(settings.stateDir).toBe('/home/a/.local/state/quickbase-mcp');
  });
});

describe('relayEnvForSpawn (what the detached daemon inherits)', () => {
  it('passes the relay settings and OS essentials, and nothing else', () => {
    const env = relayEnvForSpawn({
      QB_REALM: 'jane.quickbase.com',
      QB_RELAY_PORT: '3799',
      QB_RELAY_IDLE_MINUTES: '5',
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      QB_USER_TOKEN: 'super-secret-token',
      QB_APP_abc_NAME: 'My App',
      PIPELINES_PAGE_TOKEN: 'csrf',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      GITHUB_TOKEN: 'ghp_xxx',
    });

    expect(env).toEqual({
      QB_REALM: 'jane.quickbase.com',
      QB_RELAY_PORT: '3799',
      QB_RELAY_IDLE_MINUTES: '5',
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    });
  });

  it('omits unset and blank values', () => {
    expect(relayEnvForSpawn({ QB_REALM: 'x.quickbase.com', QB_RELAY_PORT: '', PATH: undefined })).toEqual({
      QB_REALM: 'x.quickbase.com',
    });
  });

  it('never allows a credential-looking key', () => {
    for (const key of [...RELAY_ENV_KEYS, ...OS_ENV_KEYS]) {
      expect(key).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY(?!S)|CREDENTIAL/i);
    }
  });
});

describe('loadRelayEnvFile (manual start: copy only relay settings out of .env)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-relay-test-env-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('copies only the relay keys and never QB_USER_TOKEN or app settings', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(
      file,
      ['QB_REALM=jane.quickbase.com', 'QB_USER_TOKEN=super-secret-token', 'QB_RELAY_PORT=3799', 'QB_APP_abc_NAME=My App', 'OTHER=1'].join('\n'),
    );
    const env: NodeJS.ProcessEnv = {};

    const used = loadRelayEnvFile([path.join(dir, 'missing.env'), file], env);

    expect(used).toBe(file);
    expect(env).toEqual({ QB_REALM: 'jane.quickbase.com', QB_RELAY_PORT: '3799' });
  });

  it('does not override values already present in the environment', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'QB_REALM=from-file.quickbase.com\nQB_RELAY_PORT=3799\n');
    const env: NodeJS.ProcessEnv = { QB_REALM: 'from-env.quickbase.com' };

    loadRelayEnvFile([file], env);

    expect(env).toEqual({ QB_REALM: 'from-env.quickbase.com', QB_RELAY_PORT: '3799' });
  });

  it('returns undefined and leaves the environment alone when no candidate exists', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadRelayEnvFile([path.join(dir, 'nope.env')], env)).toBeUndefined();
    expect(env).toEqual({});
  });
});
