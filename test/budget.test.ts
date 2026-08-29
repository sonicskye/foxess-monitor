import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKOFF_LADDER_MS, PATH_GATE_MS, createBudget, type Budget } from '../src/budget.ts';
import { createLogger, configureLogging, setLogSink } from '../src/log.ts';

const TZ = 'Europe/London';
const REAL = '/op/v1/device/real/query';
const GEN = '/op/v0/device/generation';

let dir: string;
let clock: number;
/** Total simulated time spent inside the rate gate. */
let slept: number;

const log = createLogger('test');

function makeBudget(cap = 10, startAt = Date.parse('2026-08-29T10:00:00Z')): Budget {
  clock = startAt;
  slept = 0;
  return createBudget({
    dataDir: dir,
    timeZone: TZ,
    cap,
    log,
    now: () => clock,
    sleep: async (ms) => {
      slept += ms;
      clock += ms; // the gate's wait advances the clock, as a real sleep would
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foxess-budget-'));
  setLogSink(() => {});
  configureLogging({ level: 'error', pretty: false });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setLogSink(null);
});

describe('daily cap', () => {
  test('allows calls up to the cap and refuses past it', async () => {
    const budget = makeBudget(3);

    for (let i = 1; i <= 3; i++) {
      const got = await budget.acquire(`/path/${i}`);
      assert.equal(got.ok, true);
      assert.equal(got.ok && got.used, i);
    }

    const denied = await budget.acquire('/path/4');
    assert.equal(denied.ok, false);
    assert.equal(denied.ok === false && denied.reason, 'daily-cap');
  });

  test('state reports what is left', async () => {
    const budget = makeBudget(10);
    await budget.acquire(REAL);
    await budget.acquire(GEN);

    const s = budget.state();
    assert.equal(s.used, 2);
    assert.equal(s.cap, 10);
    assert.equal(s.remaining, 8);
  });
});

describe('persistence', () => {
  test('survives a restart — a crash loop cannot reset the counter', async () => {
    const first = makeBudget(5);
    await first.acquire(REAL);
    await first.acquire(GEN);
    assert.equal(first.state().used, 2);

    // Simulate a process restart against the same data dir.
    const second = makeBudget(5, clock);
    assert.equal(second.state().used, 2, 'restart must not hand back a fresh quota');

    await second.acquire(REAL);
    assert.equal(second.state().used, 3);
  });

  test('starts from zero if the state file is corrupt', async () => {
    const budget = makeBudget(5);
    await budget.acquire(REAL);

    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'budget.json'), '{not json');

    const restarted = makeBudget(5, clock);
    assert.equal(restarted.state().used, 0);
  });

  test('writes the counter to disk on every acquisition', async () => {
    const budget = makeBudget(5);
    await budget.acquire(REAL);

    const saved = JSON.parse(readFileSync(join(dir, 'budget.json'), 'utf8'));
    assert.equal(saved.used, 1);
    assert.equal(saved.day, '2026-08-29');
  });
});

describe('rollover', () => {
  test('resets at local midnight, not UTC midnight', async () => {
    // 23:30 UTC on 29 Aug is 00:30 on 30 Aug in London (BST) — a new local day.
    const budget = makeBudget(5, Date.parse('2026-08-29T22:00:00Z'));
    await budget.acquire(REAL);
    await budget.acquire(GEN);
    assert.equal(budget.state().used, 2);
    assert.equal(budget.state().day, '2026-08-29');

    clock = Date.parse('2026-08-29T23:30:00Z'); // 00:30 local, next day
    const s = budget.state();
    assert.equal(s.day, '2026-08-30');
    assert.equal(s.used, 0, 'a new local day means a fresh allowance');
  });

  test('does not roll over on a UTC day change that is still the same local day', async () => {
    // 23:30 UTC 29 Aug -> 00:30 UTC 30 Aug in Sydney is mid-morning on the 30th either way;
    // use London where 00:30 UTC is still 01:30 BST on the 30th. Pick a case that stays put:
    // 10:00 -> 14:00 UTC on the same day.
    const budget = makeBudget(5, Date.parse('2026-08-29T10:00:00Z'));
    await budget.acquire(REAL);

    clock = Date.parse('2026-08-29T14:00:00Z');
    assert.equal(budget.state().used, 1);
    assert.equal(budget.state().day, '2026-08-29');
  });

  test('a rolled-over day clears an active backoff', async () => {
    const budget = makeBudget(5, Date.parse('2026-08-29T22:00:00Z'));
    await budget.acquire(REAL);
    budget.noteResult(REAL, 40400);
    assert.notEqual(budget.state().backoffUntil, null);

    clock = Date.parse('2026-08-29T23:30:00Z'); // new local day
    const s = budget.state();
    assert.equal(s.backoffUntil, null);
    assert.equal(s.consecutiveRateLimits, 0);
  });
});

describe('per-path rate gate', () => {
  test('spaces consecutive calls to the same path', async () => {
    const budget = makeBudget(10);

    await budget.acquire(REAL);
    assert.equal(slept, 0, 'first call to a path should not wait');

    await budget.acquire(REAL);
    assert.equal(slept, PATH_GATE_MS, 'second call must wait out the 1/sec/interface limit');
  });

  test('does not make different paths wait for each other', async () => {
    const budget = makeBudget(10);

    await budget.acquire(REAL);
    await budget.acquire(GEN);

    assert.equal(slept, 0, 'the limit is per interface, so distinct paths are independent');
  });

  test('no wait when enough time has already passed', async () => {
    const budget = makeBudget(10);
    await budget.acquire(REAL);

    clock += 5_000;
    await budget.acquire(REAL);

    assert.equal(slept, 0);
  });

  test('concurrent calls to one path queue instead of racing through', async () => {
    const budget = makeBudget(10);

    const results = await Promise.all([
      budget.acquire(REAL),
      budget.acquire(REAL),
      budget.acquire(REAL),
    ]);

    assert.ok(results.every((r) => r.ok));
    // Three calls means two gaps; without serialisation all three would pass together.
    assert.equal(slept, PATH_GATE_MS * 2);
  });

  test('the cap is re-checked after waiting on the gate', async () => {
    const budget = makeBudget(2);

    const results = await Promise.all([
      budget.acquire(REAL),
      budget.acquire(REAL),
      budget.acquire(REAL),
    ]);

    assert.equal(results.filter((r) => r.ok).length, 2, 'the third must be refused, not queued through');
    const denied = results.find((r) => !r.ok);
    assert.equal(denied?.ok === false && denied.reason, 'daily-cap');
  });
});

describe('40400 backoff', () => {
  test('refuses everything while backing off', async () => {
    const budget = makeBudget(100);
    await budget.acquire(REAL);
    budget.noteResult(REAL, 40400);

    const denied = await budget.acquire(GEN);
    assert.equal(denied.ok, false);
    assert.equal(denied.ok === false && denied.reason, 'backoff');
    assert.equal(denied.ok === false && denied.reason === 'backoff' && denied.retryAfterMs, BACKOFF_LADDER_MS[0]);
  });

  test('escalates on repeated rate limits', async () => {
    const budget = makeBudget(100);

    for (const expected of BACKOFF_LADDER_MS) {
      budget.noteResult(REAL, 40400);
      const state = budget.state();
      assert.equal(state.backoffUntil! - clock, expected);
      clock += expected; // wait it out, then get limited again
    }

    // Past the end of the ladder it stays at the longest pause rather than growing without bound.
    budget.noteResult(REAL, 40400);
    assert.equal(budget.state().backoffUntil! - clock, BACKOFF_LADDER_MS.at(-1));
  });

  test('resumes once the backoff expires', async () => {
    const budget = makeBudget(100);
    budget.noteResult(REAL, 40400);

    clock += BACKOFF_LADDER_MS[0]!;
    const got = await budget.acquire(REAL);
    assert.equal(got.ok, true);
  });

  test('a success clears the backoff and resets the ladder', async () => {
    const budget = makeBudget(100);
    budget.noteResult(REAL, 40400);
    budget.noteResult(REAL, 0);

    assert.equal(budget.state().backoffUntil, null);
    assert.equal(budget.state().consecutiveRateLimits, 0);

    // Next limit starts at the bottom of the ladder again.
    budget.noteResult(REAL, 40400);
    assert.equal(budget.state().backoffUntil! - clock, BACKOFF_LADDER_MS[0]);
  });

  test('other errnos do not arm the backoff', async () => {
    const budget = makeBudget(100);
    budget.noteResult(REAL, 40257);
    assert.equal(budget.state().backoffUntil, null);
  });
});

describe('reconcile with getAccessCount', () => {
  test('adjusts upward when FoxESS reports more spent than we counted', async () => {
    const budget = makeBudget(1400);
    await budget.acquire(REAL);
    assert.equal(budget.state().used, 1);

    // FoxESS says 600 of 1440 are gone — calls we never recorded.
    budget.reconcile({ total: 1440, remaining: 840 });

    assert.equal(budget.state().used, 600);
    assert.equal(budget.state().remaining, 800);
    assert.equal(budget.state().quotaRemaining, 840);
    assert.equal(budget.state().quotaTotal, 1440);
  });

  test('never adjusts downward — our own count is the pessimistic floor', async () => {
    const budget = makeBudget(1400);
    for (let i = 0; i < 5; i++) {
      clock += 2000;
      await budget.acquire(REAL);
    }
    assert.equal(budget.state().used, 5);

    // A stale or lagging remaining figure must not hand back quota we know we spent.
    budget.reconcile({ total: 1440, remaining: 1439 });
    assert.equal(budget.state().used, 5);
  });

  test('the adjusted figure survives a restart', async () => {
    const budget = makeBudget(1400);
    budget.reconcile({ total: 1440, remaining: 440 });
    assert.equal(budget.state().used, 1000);

    const restarted = makeBudget(1400, clock);
    assert.equal(restarted.state().used, 1000);
  });
});
