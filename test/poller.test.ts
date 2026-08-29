/**
 * Scheduler recovery.
 *
 * These pin the defect that a brief internet outage exposed: a failed job used to wait out its full
 * interval before trying again, so a six-hourly job that failed once stayed broken for six hours,
 * and a failed `discover` left the poller with no devices and nothing to poll at all.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPoller, type Poller } from '../src/poller.ts';
import { createMockEndpoints, MOCK_SN } from '../src/mock.ts';
import { createBudget, type Budget } from '../src/budget.ts';
import { createAuditLog, type AuditLog } from '../src/audit.ts';
import { createSampleStore, type SampleStore } from '../src/store.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { BudgetDeniedError } from '../src/foxess/types.ts';
import { configureLogging, createLogger, setLogSink } from '../src/log.ts';
import type { Endpoints } from '../src/foxess/endpoints.ts';

const TZ = 'Europe/London';
const NOW = Date.parse('2026-08-29T13:00:00Z');
const log = createLogger('test');

let dir: string;
let config: Config;
let budget: Budget;
let audit: AuditLog;
let store: SampleStore;
let poller: Poller | null = null;

/** Wait for pending microtasks and any timer callbacks scheduled for <= `ms` from now. */
const settle = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foxess-poller-'));
  setLogSink(() => {});
  configureLogging({ level: 'error', pretty: false });

  config = loadConfig({ FOXESS_MOCK: '1', TZ, DATA_DIR: dir });
  budget = createBudget({ dataDir: dir, timeZone: TZ, cap: 1400, log });
  audit = createAuditLog({ dir, timeZone: TZ, retainDays: 14, log });
  store = createSampleStore({ dir, timeZone: TZ, retainDays: 14, log });
});

afterEach(() => {
  poller?.stop();
  poller = null;
  rmSync(dir, { recursive: true, force: true });
  setLogSink(null);
});

/** Retries are driven by real timers, so the tests shrink the base delay rather than wait 30s. */
const RETRY_MS = 40;

function build(api: Endpoints, over: Partial<Config['poll']> = {}): Poller {
  poller = createPoller({
    config: { ...config, poll: { ...config.poll, ...over } },
    api,
    budget,
    audit,
    store,
    log,
    now: () => NOW,
    retryBaseMs: RETRY_MS,
  });
  return poller;
}

describe('a failed job retries early instead of waiting out its interval', () => {
  test('the settings job recovers in seconds, not six hours', async () => {
    // Exactly the reported failure: the network is down when the poller starts, so the six-hourly
    // min-SOC call fails. It must not leave the battery figures blank until the evening.
    let attempts = 0;
    const api: Endpoints = {
      ...createMockEndpoints({ timeZone: TZ, now: () => NOW }),
      async batterySoc() {
        attempts += 1;
        if (attempts === 1) throw new Error('ENOTFOUND www.foxesscloud.com');
        return { minSoc: 10, minSocOnGrid: 20 };
      },
    };

    const p = build(api, { settingsSeconds: 3600 });
    await p.start();
    // schedule() fires jobs without awaiting them, so give the first attempt a moment to land.
    await settle(20);

    assert.equal(p.state().battery.floorPercent, null, 'floor unknown while the call is failing');
    assert.equal(p.state().jobs['settings']?.failures, 1);

    // The point of the fix: recovery comes from the retry, NOT from the 6-hour interval.
    await settle(RETRY_MS * 3);

    assert.equal(attempts, 2, 'it tried again well before the interval elapsed');
    assert.equal(p.state().battery.floorPercent, 20, 'and the floor arrived');
    assert.equal(p.state().jobs['settings']?.lastError, null);
  });

  test('a success resets the backoff, so the next failure retries fast again', async () => {
    let calls = 0;
    const api: Endpoints = {
      ...createMockEndpoints({ timeZone: TZ, now: () => NOW }),
      async batterySoc() {
        calls += 1;
        // fail, succeed, fail — the third attempt must not inherit a grown backoff
        if (calls === 1 || calls === 3) throw new Error('transient');
        return { minSoc: 10, minSocOnGrid: 20 };
      },
    };

    // A short interval so the run after the success comes round quickly too.
    const p = build(api, { settingsSeconds: 1 });
    await p.start();
    await settle(1200 + RETRY_MS * 4);

    assert.ok(calls >= 3, `expected repeated attempts, got ${calls}`);
    // The third attempt failed; if the backoff had not reset it would still be waiting.
    await settle(RETRY_MS * 3);
    assert.ok(calls >= 4, `backoff should have reset after the success, got ${calls}`);
  });
});

describe('a budget-denied job does NOT fast-retry', () => {
  test('nothing was sent, the quota is spent, so retrying sooner would only waste more', async () => {
    let attempts = 0;
    const api: Endpoints = {
      ...createMockEndpoints({ timeZone: TZ, now: () => NOW }),
      async batterySoc() {
        attempts += 1;
        throw new BudgetDeniedError('/op/v0/device/battery/soc/get', 'daily-cap', 'spent');
      },
    };

    // A long interval: if budget denial were treated as a failure, the 30s backoff would fire
    // within this window and attempts would climb.
    const p = build(api, { settingsSeconds: 3600 });
    await p.start();
    await settle(20);

    const afterFirst = attempts;
    await settle(RETRY_MS * 6);

    assert.equal(attempts, afterFirst, 'a spent budget must not trigger a retry storm');
    assert.equal(p.state().jobs['settings']?.failures, 1);
    assert.match(p.state().jobs['settings']?.lastError ?? '', /Skipped/);
  });
});

describe('discovery failure no longer kills the dashboard', () => {
  test('the poller keeps retrying instead of sitting there with nothing scheduled', async () => {
    let attempts = 0;
    const api: Endpoints = {
      ...createMockEndpoints({ timeZone: TZ, now: () => NOW }),
      async deviceList() {
        attempts += 1;
        if (attempts === 1) throw new Error('ENOTFOUND');
        return [
          {
            deviceSN: MOCK_SN,
            stationName: 'Mock House',
            productType: 'H1',
            deviceType: 'H1-5.0-E',
            hasBattery: true,
            hasPV: true,
            status: 1,
          },
        ];
      },
    };

    // Previously start() returned early here and scheduled nothing at all: the process stayed up,
    // served a page and reported healthy while polling absolutely nothing.
    const p = build(api);
    await p.start();

    assert.equal(p.state().devices.length, 0, 'no devices after the first failure');
    assert.ok(p.state().jobs['discover'], 'a discover job must still be registered');

    await settle(RETRY_MS * 4);
    assert.ok(attempts >= 2, `discovery must be retried, attempts=${attempts}`);
    assert.equal(p.state().devices.length, 1, 'and the devices arrive without a restart');
  });

  test('an empty device list is a failure, not a silent success', async () => {
    const api: Endpoints = {
      ...createMockEndpoints({ timeZone: TZ, now: () => NOW }),
      async deviceList() {
        return [];
      },
    };

    const p = build(api);
    await p.start();

    // Returning "ok" here would mark a one-shot job done and never look again.
    assert.equal(p.state().jobs['discover']?.failures, 1);
    assert.match(p.state().jobs['discover']?.lastError ?? '', /no matching inverters/);
  });
});

describe('healthy startup is unaffected', () => {
  test('every job succeeds and the battery figures are populated', async () => {
    const p = build(createMockEndpoints({ timeZone: TZ, now: () => NOW }));
    await p.start();
    await settle(20);

    for (const name of ['discover', 'backfill', 'real', 'totals', 'generation', 'quota', 'settings']) {
      const job = p.state().jobs[name];
      assert.ok(job, `missing job ${name}`);
      assert.equal(job.lastError, null, `${name} failed: ${job.lastError}`);
    }

    assert.equal(p.state().battery.floorPercent, 20);
    assert.ok((p.state().battery.usableKwh ?? 0) > 0);
  });

  test('the quota job runs once at startup, not twice', async () => {
    // It used to be invoked explicitly AND scheduled, spending two calls from a rationed budget.
    const p = build(createMockEndpoints({ timeZone: TZ, now: () => NOW }));
    await p.start();
    await settle(20);

    assert.equal(p.state().jobs['quota']?.runs, 1);
  });
});
