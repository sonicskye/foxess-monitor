/**
 * The signed HTTP client.
 *
 * Every FoxESS request in the process goes through `call()`, which is the single place that:
 *   - reserves budget (nothing is sent without it),
 *   - signs the request,
 *   - unwraps the envelope and turns a non-zero `errno` into a thrown error,
 *   - feeds the result back to the budget so a 40400 arms the backoff,
 *   - writes an audit line.
 *
 * Retries are deliberately stingy. The scarce resource is quota, not latency: a failed call has
 * already been counted, so retrying costs a second call from a budget of 1440. Transport errors get
 * one retry; a bad signature or bad body gets none, because it will fail identically forever.
 */

import type { Budget } from '../budget.ts';
import type { AuditLog } from '../audit.ts';
import type { Logger } from '../log.ts';
import { signHeaders, signablePath } from './sign.ts';
import { BudgetDeniedError, ERRNO, FoxApiError, type FoxEnvelope } from './types.ts';

export interface ClientOptions {
  apiBase: string;
  apiKey: string;
  budget: Budget;
  audit: AuditLog;
  log: Logger;
  /** Per-request timeout. The API is normally sub-second; 20s means something is wrong. */
  timeoutMs?: number;
  /** Extra attempts after a transport failure. One is plenty when calls are rationed. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CallOptions {
  method: 'GET' | 'POST';
  path: string;
  /** GET query parameters. Never part of the signature. */
  query?: Record<string, string | number | undefined>;
  /** POST JSON body. */
  body?: unknown;
}

export interface FoxClient {
  call<T>(opts: CallOptions): Promise<T>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createClient(opts: ClientOptions): FoxClient {
  const { apiBase, apiKey, budget, audit, log } = opts;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxRetries = opts.maxRetries ?? 1;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  function buildUrl(path: string, query: CallOptions['query']): string {
    const url = new URL(path, apiBase);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async function attempt<T>(
    call: CallOptions,
    path: string,
    attemptNo: number,
    budgetUsed: number,
    budgetCap: number,
  ): Promise<T> {
    const url = buildUrl(path, call.query);
    // Sign the PATH only — never the query string.
    const headers = signHeaders(path, apiKey, { now: now() });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = now();

    let status = 0;
    let bytes = 0;
    let errno: number | null = null;
    let failure: string | undefined;

    try {
      const response = await doFetch(url, {
        method: call.method,
        headers,
        body: call.method === 'POST' ? JSON.stringify(call.body ?? {}) : undefined,
        signal: controller.signal,
      });

      status = response.status;
      const text = await response.text();
      bytes = text.length;

      if (!response.ok) {
        failure = `HTTP ${status}`;
        const err = new Error(`FoxESS ${path} returned HTTP ${status}`);
        (err as Error & { retryable?: boolean }).retryable = RETRYABLE_STATUS.has(status);
        throw err;
      }

      let envelope: FoxEnvelope<T>;
      try {
        envelope = JSON.parse(text) as FoxEnvelope<T>;
      } catch {
        failure = 'unparseable body';
        // An HTML error page or a truncated response. Worth retrying once.
        const err = new Error(`FoxESS ${path} returned a non-JSON body (${bytes} bytes)`);
        (err as Error & { retryable?: boolean }).retryable = true;
        throw err;
      }

      errno = typeof envelope.errno === 'number' ? envelope.errno : null;

      if (errno !== ERRNO.OK) {
        failure = `errno ${errno}`;
        throw new FoxApiError(path, errno ?? -1, envelope.msg);
      }

      return envelope.result;
    } catch (err) {
      if (failure === undefined) {
        failure = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : String(err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      audit.record({
        ts: new Date(startedAt).toISOString(),
        path,
        ms: now() - startedAt,
        status,
        errno,
        bytes,
        budgetUsed,
        budgetCap,
        quotaRemaining: budget.state().quotaRemaining,
        attempt: attemptNo,
        ...(failure === undefined ? {} : { error: failure }),
      });
      // Let the budget see every verdict: a 40400 arms the backoff, a success clears it.
      budget.noteResult(path, errno);
    }
  }

  return {
    async call<T>(call: CallOptions): Promise<T> {
      const path = signablePath(call.path);
      let lastError: unknown;

      for (let attemptNo = 1; attemptNo <= maxRetries + 1; attemptNo++) {
        // Reserved per attempt, because a retry is a second real call against the quota.
        const reservation = await budget.acquire(path);
        if (!reservation.ok) {
          if (reservation.reason === 'daily-cap') {
            throw new BudgetDeniedError(
              path,
              'daily-cap',
              `daily API budget spent (${reservation.used}/${reservation.cap})`,
            );
          }
          throw new BudgetDeniedError(
            path,
            'backoff',
            `backing off after a rate limit, ${Math.ceil(reservation.retryAfterMs / 1000)}s remaining`,
            reservation.retryAfterMs,
          );
        }

        try {
          return await attempt<T>(call, path, attemptNo, reservation.used, reservation.cap);
        } catch (err) {
          lastError = err;

          const isLast = attemptNo === maxRetries + 1;
          const retryable =
            err instanceof FoxApiError
              ? err.isRetryable && !err.isRateLimit
              : ((err as Error & { retryable?: boolean }).retryable ?? true);

          if (isLast || !retryable) {
            if (err instanceof FoxApiError) {
              log.warn('FoxESS call failed', {
                path,
                errno: err.errno,
                detail: err.message,
                attempt: attemptNo,
              });
            }
            throw err;
          }

          const waitMs = 2_000 * attemptNo;
          log.warn('FoxESS call failed — retrying', { path, attempt: attemptNo, waitMs, err });
          await sleep(waitMs);
        }
      }

      throw lastError;
    },
  };
}
