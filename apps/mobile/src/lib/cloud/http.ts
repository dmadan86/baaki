/**
 * The HTTP shapes the providers need, in one place.
 *
 * A ledger backup is a string the app already holds in memory, not a file on
 * disk, so there is nothing to stream: plain `fetch` covers every call. (The
 * deleted image-backup version of this module used expo-file-system's native
 * uploader to avoid base64-ing megabytes of JPEG through the bridge; a few
 * hundred kilobytes of JSON does not earn that.)
 *
 * Everything non-2xx throws a `CloudHttpError` carrying the status and body,
 * so the backup engine can tell a retryable network blip from a dead token —
 * and so the raw body never has to be shown to anybody: it goes to the crash
 * reporter through `friendlyError`, and the screen gets a sentence.
 */

export class CloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`cloud request failed (${status}): ${body.slice(0, 300)}`);
    this.name = 'CloudHttpError';
  }
}

/** True for the statuses that mean "these tokens are no longer any good". */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof CloudHttpError && (error.status === 401 || error.status === 403);
}

/** A JSON request; returns the parsed body. */
export async function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) throw new CloudHttpError(response.status, text);
  return parse(text);
}

/** A request whose body is raw text (an upload); returns the parsed response. */
export async function requestRaw(
  url: string,
  options: { method: string; headers: Record<string, string>; body: string },
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  const text = await response.text();
  if (!response.ok) throw new CloudHttpError(response.status, text);
  return parse(text);
}

/** A request whose *response* is the payload — the download side. */
export async function requestText(
  url: string,
  options: { headers: Record<string, string> },
): Promise<string> {
  const response = await fetch(url, { headers: options.headers });
  const text = await response.text();
  if (!response.ok) throw new CloudHttpError(response.status, text);
  return text;
}

function parse(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}
