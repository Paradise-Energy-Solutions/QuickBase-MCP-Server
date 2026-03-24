import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { envFlag, loadAppRegistry, loadDotenv } from '../src/utils/env';

describe('env helpers', () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  it('parses common boolean env forms', () => {
    // True values
    process.env.TEST_FLAG = 'true';
    expect(envFlag('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = '1';
    expect(envFlag('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'yes';
    expect(envFlag('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'y';
    expect(envFlag('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'on';
    expect(envFlag('TEST_FLAG')).toBe(true);

    // False values
    process.env.TEST_FLAG = 'false';
    expect(envFlag('TEST_FLAG', true)).toBe(false);
    process.env.TEST_FLAG = '0';
    expect(envFlag('TEST_FLAG', true)).toBe(false);
    process.env.TEST_FLAG = 'no';
    expect(envFlag('TEST_FLAG', true)).toBe(false);
    process.env.TEST_FLAG = 'n';
    expect(envFlag('TEST_FLAG', true)).toBe(false);
    process.env.TEST_FLAG = 'off';
    expect(envFlag('TEST_FLAG', true)).toBe(false);
  });

  it('loads .env from parent of entrypoint when cwd does not contain it', () => {
    delete process.env.QB_READONLY;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-mcp-env-'));
    try {
      const tmpDist = path.join(tmpRoot, 'dist');
      fs.mkdirSync(tmpDist, { recursive: true });

      fs.writeFileSync(path.join(tmpRoot, '.env'), 'QB_READONLY=true\n', 'utf8');

      // Make sure default dotenv lookup (cwd/.env) fails
      process.chdir(tmpDist);

      loadDotenv(pathToFileURL(path.join(tmpDist, 'index.js')).toString());
      expect(process.env.QB_READONLY).toBe('true');
      expect(envFlag('QB_READONLY')).toBe(true);
    } finally {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});

describe('loadAppRegistry', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns empty map when no QB_APP_ entries present', () => {
    for (const key of Object.keys(process.env).filter(k => k.startsWith('QB_APP_'))) {
      delete process.env[key];
    }
    const registry = loadAppRegistry();
    expect(registry.size).toBe(0);
  });

  it('registers a single app with explicit safety flags', () => {
    process.env.QB_APP_abc123_NAME = 'Test App';
    process.env.QB_APP_abc123_READONLY = 'false';
    process.env.QB_APP_abc123_ALLOW_DESTRUCTIVE = 'true';

    const registry = loadAppRegistry();
    expect(registry.has('abc123')).toBe(true);
    const app = registry.get('abc123')!;
    expect(app.id).toBe('abc123');
    expect(app.name).toBe('Test App');
    expect(app.readOnly).toBe(false);
    expect(app.allowDestructive).toBe(true);
  });

  it('applies safe defaults when safety flags are omitted', () => {
    process.env.QB_APP_xyz789_NAME = 'Restricted App';
    delete process.env.QB_APP_xyz789_READONLY;
    delete process.env.QB_APP_xyz789_ALLOW_DESTRUCTIVE;

    const registry = loadAppRegistry();
    const app = registry.get('xyz789')!;
    expect(app.readOnly).toBe(true);
    expect(app.allowDestructive).toBe(false);
  });

  it('registers multiple apps', () => {
    process.env.QB_APP_app1_NAME = 'App One';
    process.env.QB_APP_app2_NAME = 'App Two';
    process.env.QB_APP_app3_NAME = 'App Three';

    const registry = loadAppRegistry();
    expect(registry.has('app1')).toBe(true);
    expect(registry.has('app2')).toBe(true);
    expect(registry.has('app3')).toBe(true);
    expect(registry.get('app1')!.name).toBe('App One');
    expect(registry.get('app2')!.name).toBe('App Two');
    expect(registry.get('app3')!.name).toBe('App Three');
  });

  it('ignores unrelated QB_APP_ env keys', () => {
    process.env.QB_APP_abc_READONLY = 'true';  // no _NAME counterpart
    const registry = loadAppRegistry();
    expect(registry.has('abc')).toBe(false);
  });
});
