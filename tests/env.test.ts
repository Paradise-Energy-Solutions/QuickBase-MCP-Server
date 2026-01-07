import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { envFlag, loadDotenv } from '../src/utils/env';

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
