import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off']);

export function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return defaultValue;

  const normalized = String(raw).trim().toLowerCase();
  if (normalized.length === 0) return defaultValue;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return defaultValue;
}

/**
 * Loads environment variables from a .env file.
 *
 * This first attempts dotenv's default behavior (process.cwd()), then falls
 * back to a .env located one directory above the caller's file location.
 *
 * The fallback is important when the server is launched by an MCP client with
 * a working directory that is not the repository/package root.
 */
export function loadDotenv(callerUrl?: string): void {
  const first = dotenv.config();
  if (!first.error) return;

  // If dotenv failed due to missing file, try a path relative to the entrypoint.
  // For dist/index.js, this resolves to <packageRoot>/.env
  const callerDir = callerUrl
    ? path.dirname(fileURLToPath(callerUrl))
    : process.cwd();

  const fallbackPath = path.resolve(callerDir, '..', '.env');
  dotenv.config({ path: fallbackPath });
}
