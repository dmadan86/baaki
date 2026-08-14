/**
 * The two HTTP shapes the providers need, kept in one place.
 *
 * `uploadFile` streams a local file's bytes as the raw request body using
 * expo-file-system's native uploader — no base64 round trip through JS, which
 * for a 2000px receipt is megabytes of string we would otherwise build, hold
 * and hand across the bridge. `postJson` is the ordinary small metadata call.
 *
 * Both throw a `CloudHttpError` carrying the status and body on a non-2xx, so
 * the backup queue can tell a retryable network blip from a dead token.
 */

import { File, UploadType } from 'expo-file-system';

export class CloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`cloud request failed (${status}): ${body.slice(0, 300)}`);
    this.name = 'CloudHttpError';
  }
}

/** Upload a local file as the raw body; returns the parsed JSON response. */
export async function uploadFile(
  localUri: string,
  url: string,
  options: { method?: 'POST' | 'PUT' | 'PATCH'; headers: Record<string, string>; mimeType: string },
): Promise<Record<string, unknown>> {
  const result = await new File(localUri).upload(url, {
    httpMethod: options.method ?? 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    headers: options.headers,
    mimeType: options.mimeType,
  });

  if (result.status < 200 || result.status >= 300) {
    throw new CloudHttpError(result.status, result.body);
  }
  return parse(result.body);
}

/** A JSON request (metadata create, folder lookup); returns the parsed body. */
export async function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown },
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

function parse(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}
