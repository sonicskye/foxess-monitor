/**
 * API call budget enforcement.
 *
 * FoxESS allows 1440 calls per day per inverter. Exceeding it returns errno 40400 and the API stops
 * answering — for a wall display, that means a frozen screen until midnight. The schedule is
 * *designed* to fit (~1272/day), but a schedule is a plan and this is the enforcement: no request
 * leaves the process without passing through `acquire()`.
 *
 * Three separate limits, because they fail in different ways:
 *
 *  1. **Daily cap** — the hard ceiling. Persisted, so a restart loop cannot reset the counter and
 *     spend the day's quota over and over.
 *  2. **Per-path rate gate** — the documented 1 call/sec/interface limit. Only bites during the
 *     startup burst, where discovery, backfill and the first poll fire together. We *wait* rather
 *     than refuse: the caller wanted the data and a second's delay is free.
 *  3. **40400 backoff** — when the API says stop, stop. Escalating, and long, because retrying into
 *     a rate limit is what turns a brief problem into a spent day.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './log.ts';
import { dayKey } from './localdate.ts';

/** The documented per-interface minimum spacing, plus a little slack for clock jitter. */
export const PATH_GATE_MS = 1_100;

/** Escalating pauses after a 40400. Retrying into a rate limit is how a bad minute becomes a bad day. */
export const BACKOFF_LADDER_MS = [60_000, 300_000, 900_000];

export type Denial =
  | { ok: false; reason: 'daily-cap'; used: number; cap: number }
  | { ok: false; reason: 'backoff'; retryAfterMs: number };

export type Acquisition = { ok: true; used: number; cap: number } | Denial;

export interface BudgetState {
  day: string;
  used: number;
  cap: number;
  /** cap - used, floored at 0. */
  remaining: number;
  /** `remaining` as last reported by FoxESS itself, or null if never fetched. */
  quotaRemaining: number | null;
  /** `total` as last reported by FoxESS itself. */
  quotaTotal: number | null;
  backoffUntil: number | null;
  consecutiveRateLimits: number;
}

interface Persisted {
  day: string;
  used: number;
  quotaRemaining: number | null;
  quotaTotal: number | null;
}

export interface Budget {
  /**
   * Reserve one call for `path`. Resolves once the per-path gate allows it, or immediately with a
   * denial. A successful acquisition has already incremented the counter — assume the call happened.
   */
  acquire(path: string): Promise<Acquisition>;
  /** Feed back the API's verdict so a 40400 arms the backoff and success clears it. */
  noteResult(path: string, errno: number | null): void;
  /** Reconcile against getAccessCount, which is authoritative. */
  reconcile(input: { total: number; remaining: number }): void;
  state(): BudgetState;
}

export interface BudgetOptions {
  dataDir: string;
  timeZone: string;
  cap: number;
  log: Logger;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const FILE = 'budget.json';

export function createBudget(opts: BudgetOptions): Budget {
  const { dataDir, timeZone, cap, log } = opts;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const file = join(dataDir, FILE);
  mkdirSync(dataDir, { recursive: true });

  let day = dayKey(new Date(now()), timeZone);
  let used = 0;
  let quotaRemaining: number | null = null;
  let quotaTotal: number | null = null;
  let backoffUntil: number | null = null;
  let consecutiveRateLimits = 0;

  /** Last start time per path, and a per-path promise chain so concurrent callers queue. */
  const lastCallAt = new Map<string, number>();
  const pathChain = new Map<string, Promise<void>>();

  function load(): void {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>;
      if (typeof parsed.day === 'string' && typeof parsed.used === 'number') {
        day = parsed.day;
        used = parsed.used;
        quotaRemaining = typeof parsed.quotaRemaining === 'number' ? parsed.quotaRemaining : null;
        quotaTotal = typeof parsed.quotaTotal === 'number' ? parsed.quotaTotal : null;
      }
    } catch {
      // No file on first run, or corrupt after an unclean shutdown. Starting from zero is the
      // safe direction: the reconcile against getAccessCount will correct us upward within the hour.
    }
  }

  function persist(): void {
    const data: Persisted = { day, used, quotaRemaining, quotaTotal };
    try {
      writeFileSync(file, JSON.stringify(data));
    } catch (err) {
      log.warn('could not persist budget counter', { file, err });
    }
  }

  /** Reset the counter when the local day changes. */
  function rollover(): void {
    const today = dayKey(new Date(now()), timeZone);
    if (today === day) return;

    log.info('budget rolled over to a new day', { from: day, to: today, spent: used, cap });
    day = today;
    used = 0;
    quotaRemaining = null;
    quotaTotal = null;
    // A new day's quota is a fresh start; nothing about yesterday should hold us back.
    backoffUntil = null;
    consecutiveRateLimits = 0;
    persist();
  }

  /** Serialise on `path` so two concurrent callers cannot both pass the gate. */
  async function waitForPathGate(path: string): Promise<void> {
    const previous = pathChain.get(path) ?? Promise.resolve();

    const mine = previous.then(async () => {
      const last = lastCallAt.get(path);
      const wait = last === undefined ? 0 : last + PATH_GATE_MS - now();
      if (wait > 0) {
        log.debug('waiting on per-path rate gate', { path, waitMs: wait });
        await sleep(wait);
      }
      lastCallAt.set(path, now());
    });

    pathChain.set(
      path,
      mine.catch(() => undefined),
    );
    await mine;
  }

  load();

  return {
    async acquire(path) {
      rollover();

      if (backoffUntil !== null) {
        if (now() < backoffUntil) {
          return { ok: false, reason: 'backoff', retryAfterMs: backoffUntil - now() };
        }
        backoffUntil = null;
      }

      if (used >= cap) {
        return { ok: false, reason: 'daily-cap', used, cap };
      }

      await waitForPathGate(path);

      // Re-check after the wait: the day may have turned, or the cap may have been reached by
      // another caller that went through while we were queued.
      rollover();
      if (used >= cap) return { ok: false, reason: 'daily-cap', used, cap };

      used += 1;
      persist();
      return { ok: true, used, cap };
    },

    noteResult(path, errno) {
      if (errno === 40400) {
        const step = Math.min(consecutiveRateLimits, BACKOFF_LADDER_MS.length - 1);
        const waitMs = BACKOFF_LADDER_MS[step]!;
        consecutiveRateLimits += 1;
        backoffUntil = now() + waitMs;

        log.warn('rate limited by FoxESS (40400) — backing off', {
          path,
          waitMs,
          resumeAt: new Date(backoffUntil).toISOString(),
          consecutive: consecutiveRateLimits,
          used,
          cap,
        });
        return;
      }

      if (errno === 0) {
        if (consecutiveRateLimits > 0) {
          log.info('rate limit cleared', { path, after: consecutiveRateLimits });
        }
        consecutiveRateLimits = 0;
        backoffUntil = null;
      }
    },

    reconcile({ total, remaining }) {
      rollover();
      quotaTotal = total;
      quotaRemaining = remaining;

      // FoxESS is authoritative. If it says more has been spent than we counted — a restart that
      // lost the file, another client on the same key, or calls we failed to record — believe it.
      const reportedUsed = total - remaining;
      if (reportedUsed > used) {
        log.info('adjusting budget counter up to match FoxESS', {
          localUsed: used,
          reportedUsed,
          total,
          remaining,
        });
        used = reportedUsed;
      }
      persist();
    },

    state() {
      rollover();
      return {
        day,
        used,
        cap,
        remaining: Math.max(0, cap - used),
        quotaRemaining,
        quotaTotal,
        backoffUntil,
        consecutiveRateLimits,
      };
    },
  };
}
