import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../types/quickbase.js';

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
/**
 * Scans process.env for QB_APP_<id>_NAME entries and builds a registry of
 * registered QuickBase apps with their per-app safety settings.
 * Must be called after loadDotenv().
 */
export function loadAppRegistry(): Map<string, AppConfig> {
  const registry = new Map<string, AppConfig>();
  const pattern = /^QB_APP_([A-Za-z0-9]+)_NAME$/;
  for (const key of Object.keys(process.env)) {
    const match = pattern.exec(key);
    if (!match) continue;
    const id = match[1];
    registry.set(id, {
      id,
      name: (process.env[key] ?? '').trim(),
      readOnly: envFlag(`QB_APP_${id}_READONLY`, true),
      allowDestructive: envFlag(`QB_APP_${id}_ALLOW_DESTRUCTIVE`, false)
    });
  }
  return registry;
}

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
