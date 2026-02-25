import axios from 'axios';

/**
 * Format an unknown error value into a human-readable log string.
 *
 * Provides richer detail for Axios errors (HTTP status, method, URL).
 * Handles plain Error objects, raw strings, and arbitrary serialisable values.
 *
 * @param error - The caught error value (type `unknown`).
 * @returns A concise, single-line description suitable for logging.
 */
export function formatErrorForLog(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const method = error.config?.method?.toUpperCase();
    const url = error.config?.url;
    const message = error.message;
    return `AxiosError${status ? ` ${status}` : ''}${method && url ? ` ${method} ${url}` : ''}: ${message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  try {
    return typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}
