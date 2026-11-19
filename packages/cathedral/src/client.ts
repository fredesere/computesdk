/**
 * A small HTTP client for the Cathedral sandbox API (https://cathedral.computer/openapi.json).
 *
 * There is no npm SDK to wrap: the API is plain JSON over HTTPS, so this talks to it with
 * `fetch`. It owns the three things every call needs: the bearer key, a real User-Agent
 * (cathedral.computer's edge refuses generic HTTP client agents), and Idempotency-Key handling
 * so a request whose response was lost can be resent without running twice.
 */

import { randomUUID } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://cathedral.computer';
export const PACKAGE_USER_AGENT = 'computesdk-cathedral/0.1 (+https://www.computesdk.com)';

export interface CathedralClientOptions {
  /** Cathedral API key (`cat_sk_...`). Falls back to CATHEDRAL_API_KEY. */
  apiKey?: string;
  /** API origin. Falls back to CATHEDRAL_BASE_URL, then https://cathedral.computer. */
  baseUrl?: string;
  /** Act for a team; its owner's prepaid balance pays. Falls back to CATHEDRAL_TEAM_ID. */
  teamId?: string;
  /** Override the User-Agent header. A generic agent such as `node` is refused at the edge. */
  userAgent?: string;
  /**
   * How many times to resend a request that failed in transport or with a retryable 5xx.
   * Mutating requests are resent with the same Idempotency-Key, so they run at most once.
   * Default 2.
   */
  retries?: number;
}

/** Error body shape shared by every sandbox, image, quota and usage route. */
export interface CathedralErrorBody {
  error?: string;
  public_message?: string;
  failed_by?: 'you' | 'cathedral' | string;
  billed?: boolean;
  retry_after_s?: number | null;
  detail?: unknown;
}

export class CathedralError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly failedBy: string | undefined;
  readonly retryAfterS: number | undefined;
  readonly body: unknown;

  constructor(operation: string, status: number, body: unknown) {
    const parsed = (body && typeof body === 'object' ? body : {}) as CathedralErrorBody;
    const code = errorCode(parsed);
    const sentence = parsed.public_message || parsed.error || (typeof body === 'string' ? body : '');
    super(
      `Cathedral ${operation} failed (${status}${code ? ` ${code}` : ''}${parsed.failed_by ? `, failed_by=${parsed.failed_by}` : ''})` +
        (sentence ? `: ${String(sentence).slice(0, 500)}` : ''),
    );
    this.name = 'CathedralError';
    this.status = status;
    this.code = code;
    this.failedBy = parsed.failed_by;
    this.retryAfterS = typeof parsed.retry_after_s === 'number' ? parsed.retry_after_s : undefined;
    this.body = body;
  }
}

function errorCode(body: CathedralErrorBody): string | undefined {
  const detail = body.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const inner = (detail as Record<string, unknown>).error;
    if (typeof inner === 'string') return inner;
  }
  return undefined;
}

/** Idempotency keys: 8 to 128 characters of `A-Z a-z 0-9 . _ : -`. */
export function idempotencyKey(prefix: string): string {
  return `computesdk-${prefix}-${randomUUID()}`;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  /** JSON body. Mutually exclusive with `raw`. */
  json?: unknown;
  /** Raw body sent as application/octet-stream. */
  raw?: string | Uint8Array;
  idempotencyKey?: string;
  /** Statuses that return normally instead of throwing (e.g. 404 on a lookup). */
  allow?: number[];
  /** Resend on transport failure / retryable 5xx. Default true for GET or keyed requests. */
  retry?: boolean;
  /** Return the response body as text instead of parsed JSON. */
  text?: boolean;
  signal?: AbortSignal;
}

export interface CathedralResponse<T> {
  status: number;
  body: T;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export class CathedralClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly teamId: string | undefined;
  readonly userAgent: string;
  readonly retries: number;

  constructor(options: CathedralClientOptions = {}) {
    const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);
    const apiKey = options.apiKey || env.CATHEDRAL_API_KEY || '';
    if (!apiKey) {
      throw new Error(
        'Missing Cathedral API key.\n\n' +
          'Create one at https://cathedral.computer/account/ (or let an agent request one, see https://cathedral.computer/agents.md).\n' +
          "Then pass it: cathedral({ apiKey: 'cat_sk_...' })\n" +
          'Or set CATHEDRAL_API_KEY in your environment.',
      );
    }
    const baseUrl = (options.baseUrl || env.CATHEDRAL_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(baseUrl)) {
      throw new Error(`Cathedral baseUrl must be https (got ${baseUrl}); the API key is a bearer credential.`);
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.teamId = options.teamId || env.CATHEDRAL_TEAM_ID || undefined;
    this.userAgent = options.userAgent || PACKAGE_USER_AGENT;
    this.retries = Math.max(0, options.retries ?? 2);
  }

  url(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T = unknown>(operation: string, path: string, options: RequestOptions = {}): Promise<CathedralResponse<T>> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': this.userAgent,
      Accept: options.text ? '*/*' : 'application/json',
    };
    if (this.teamId) headers['X-Cathedral-Team'] = this.teamId;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let body: string | Uint8Array | undefined;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.raw !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = options.raw;
    }

    // Only resend what is safe to resend: reads, and writes that carry an Idempotency-Key.
    const canRetry = options.retry ?? (method === 'GET' || Boolean(options.idempotencyKey));
    const attempts = canRetry ? this.retries + 1 : 1;
    const url = this.url(path, options.query);

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, { method, headers, body: body as BodyInit | undefined, signal: options.signal });
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted || attempt === attempts - 1) break;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (response.ok || options.allow?.includes(response.status)) {
        const parsed = await readBody(response, options.text);
        return { status: response.status, body: parsed as T };
      }

      const errorBody = await readBody(response, false);
      const error = new CathedralError(operation, response.status, errorBody);
      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1 && isReplaySafe(errorBody)) {
        lastError = error;
        await sleep(error.retryAfterS !== undefined ? Math.min(error.retryAfterS, 10) * 1000 : backoffMs(attempt));
        continue;
      }
      throw error;
    }
    if (lastError instanceof CathedralError) throw lastError;
    throw new Error(
      `Cathedral ${operation} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

/** 502 exec_outcome_unknown / process_start_unknown carry replay_safe: false and must not be resent. */
function isReplaySafe(body: unknown): boolean {
  if (!body || typeof body !== 'object') return true;
  const detail = (body as CathedralErrorBody).detail;
  if (detail && typeof detail === 'object' && (detail as Record<string, unknown>).replay_safe === false) return false;
  return (body as Record<string, unknown>).replay_safe !== false;
}

async function readBody(response: Response, asText?: boolean): Promise<unknown> {
  if (response.status === 204) return asText ? '' : undefined;
  const text = await response.text();
  if (asText) return text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(2000, 200 * 2 ** attempt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
