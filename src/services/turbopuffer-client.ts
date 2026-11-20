/** Minimal turbopuffer HTTP client: writes and queries only. */

import * as https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";

import { asRecord, asString, errorMessage } from "./jsonl.js";

const REQUEST_TIMEOUT_MS = 60_000;
/** Large write batches are embedded server-side before they are acknowledged. */
const WRITE_TIMEOUT_MS = 10 * 60_000;
const MAX_RETRIES = 4;
/**
 * Native embedding is rate limited per org and model (2M tokens per minute by
 * default), so a backfill spends minutes waiting out 429s and must not give up.
 */
const WRITE_MAX_RETRIES = 60;
const MAX_WAIT_MS = 60_000;

/** Replaceable in tests. */
export const retryPolicy = { baseMs: 800 };

export interface TurbopufferRequestContext {
  baseUrl: string;
  apiKey: string;
  /** Called before each backoff wait. */
  onRetry?: (waitMs: number, status: number) => void;
}

export class TurbopufferError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TurbopufferError";
    this.status = status;
  }
}

const agent = new https.Agent({ keepAlive: true });

interface SendInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/**
 * fetch closes idle connections after about four seconds, and every new one
 * costs three round trips. This agent holds them open between keystrokes.
 */
function keepAliveSend(url: string, init: SendInit): Promise<Response> {
  // A large body would otherwise need a second TCP flight on an idle connection.
  const compress = init.body !== undefined && init.body.length > 8192;
  const body = compress ? gzipSync(init.body!) : init.body;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      agent, method: init.method, signal: init.signal,
      headers: { ...init.headers, "Accept-Encoding": "gzip", ...(compress ? { "Content-Encoding": "gzip" } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const status = res.statusCode ?? 0;
        resolve(new Response(
          status === 204 || status === 304 ? null : res.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw,
          { status, statusText: res.statusMessage, headers: { "retry-after": res.headers["retry-after"] ?? "" } },
        ));
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Replaceable in tests. */
export const transport = { send: keepAliveSend };

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await sleep(ms, undefined, { signal });
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = asRecord((await response.json()) as unknown);
    return payload === null
      ? response.statusText
      : (asString(payload.error) ?? response.statusText);
  } catch {
    return response.statusText;
  }
}

function backoff(attempt: number): number {
  return Math.min(MAX_WAIT_MS, retryPolicy.baseMs * 2 ** attempt) * (0.5 + Math.random() / 2);
}

async function request(
  context: TurbopufferRequestContext,
  method: "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  maxRetries: number = MAX_RETRIES,
): Promise<Record<string, unknown>> {
  const url = `${context.baseUrl}${path}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);

  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();

    let response: Response;
    try {
      response = await transport.send(url, {
        method,
        headers: {
          Authorization: `Bearer ${context.apiKey}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      // Network blips are worth one more try.
      if (attempt < maxRetries) {
        const waitMs = backoff(attempt);
        context.onRetry?.(waitMs, 0);
        await delay(waitMs, signal);
        continue;
      }
      throw new TurbopufferError(
        0,
        `Could not reach turbopuffer: ${errorMessage(error)}`,
      );
    }

    // Rate limiting and transient server errors are retried with backoff.
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < maxRetries
    ) {
      const retryAfter = Number(response.headers.get("retry-after"));
      // Jitter keeps concurrent writers from all retrying the moment the bucket refills.
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000 + Math.random() * 1000
          : backoff(attempt);
      context.onRetry?.(waitMs, response.status);
      await delay(waitMs, signal);
      continue;
    }

    if (!response.ok) {
      throw new TurbopufferError(response.status, await readError(response));
    }

    if (response.status === 204) return {};
    return asRecord((await response.json()) as unknown) ?? {};
  }
}

export async function upsertRows(
  context: TurbopufferRequestContext,
  namespace: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  await request(
    context,
    "POST",
    `/v2/namespaces/${encodeURIComponent(namespace)}`,
    body,
    signal,
    WRITE_TIMEOUT_MS,
    WRITE_MAX_RETRIES,
  );
}

export async function queryNamespace(
  context: TurbopufferRequestContext,
  namespace: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const payload = await request(
    context,
    "POST",
    `/v2/namespaces/${encodeURIComponent(namespace)}/query`,
    body,
    signal,
  );
  const rows = payload.rows;
  if (Array.isArray(rows)) return toRecords(rows);

  // Multi-query (hybrid) responses nest one result set per sub-query.
  const results = payload.results;
  if (Array.isArray(results)) {
    const merged: Record<string, unknown>[] = [];
    for (const entry of results) {
      const record = asRecord(entry);
      const nested = record === null ? null : record.rows;
      if (Array.isArray(nested)) merged.push(...toRecords(nested));
    }
    return merged;
  }

  return [];
}

function toRecords(values: unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const value of values) {
    const record = asRecord(value);
    if (record !== null) result.push(record);
  }
  return result;
}
