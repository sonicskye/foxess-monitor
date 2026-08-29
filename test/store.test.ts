import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_THRESHOLD_MS, createSampleStore, downsample, type SampleStore } from '../src/store.ts';
import type { Sample } from '../src/normalize.ts';
import { configureLogging, createLogger, setLogSink } from '../src/log.ts';

const TZ = 'Europe/London';
const log = createLogger('test');

let dir: string;
let store: SampleStore;

function sample(t: number, over: Partial<Sample> = {}): Sample {
  return { t, solarKw: 1, loadKw: 0.5, gridKw: -0.5, batteryKw: 0, soc: 50, ...over };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foxess-store-'));
  setLogSink(() => {});
  configureLogging({ level: 'error', pretty: false });
  store = createSampleStore({ dir, timeZone: TZ, retainDays: 14, log });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setLogSink(null);
});

describe('append and read', () => {
  test('round-trips samples for the local day', () => {
    const base = Date.parse('2026-08-29T12:00:00Z');
    store.append(sample(base, { soc: 70 }));
    store.append(sample(base + 90_000, { soc: 71 }));

    const read = store.readDay(new Date(base));
    assert.equal(read.length, 2);
    assert.deepEqual(read.map((s) => s.soc), [70, 71]);
  });

  test('returns empty for a day with no file', () => {
    assert.deepEqual(store.readDay(new Date('2020-01-01T12:00:00Z')), []);
  });

  test('writes to a file named for the LOCAL day', () => {
    // 23:30 UTC is already 00:30 the next day in London (BST), so this belongs to the 30th.
    store.append(sample(Date.parse('2026-08-29T23:30:00Z')));

    assert.ok(existsSync(join(dir, 'samples-2026-08-30.ndjson')));
    assert.ok(!existsSync(join(dir, 'samples-2026-08-29.ndjson')));
  });

  test('survives a torn final line from a power cut', () => {
    const base = Date.parse('2026-08-29T12:00:00Z');
    store.append(sample(base));
    store.append(sample(base + 90_000));

    const file = join(dir, 'samples-2026-08-29.ndjson');
    writeFileSync(file, readFileSync(file, 'utf8') + '{"t":123,"solar');

    const read = store.readDay(new Date(base));
    assert.equal(read.length, 2, 'the intact lines must still be readable — this is why it is append-only');
  });

  test('sorts on read even if written out of order', () => {
    const base = Date.parse('2026-08-29T12:00:00Z');
    store.append(sample(base + 90_000, { soc: 2 }));
    store.append(sample(base, { soc: 1 }));

    assert.deepEqual(store.readDay(new Date(base)).map((s) => s.soc), [1, 2]);
  });
});

describe('backfill', () => {
  const noon = Date.parse('2026-08-29T12:00:00Z');

  test('merges history without duplicating what we already hold', () => {
    store.append(sample(noon, { soc: 70 }));

    const added = store.backfill(
      [sample(noon - 3600_000, { soc: 60 }), sample(noon, { soc: 99 }), sample(noon - 1800_000, { soc: 65 })],
      new Date(noon + 60_000),
    );

    assert.equal(added, 2, 'the already-present timestamp must not be re-added');
    const read = store.readDay(new Date(noon));
    assert.deepEqual(read.map((s) => s.soc), [60, 65, 70]);
    assert.equal(read[2]!.soc, 70, 'existing samples win over backfilled duplicates');
  });

  test('ignores samples from before local midnight', () => {
    // Local midnight on 29 Aug BST is 2026-08-28T23:00Z.
    const added = store.backfill(
      [sample(Date.parse('2026-08-28T20:00:00Z')), sample(noon)],
      new Date(noon + 60_000),
    );
    assert.equal(added, 1);
  });

  test('ignores samples from the future', () => {
    const added = store.backfill([sample(noon + 3600_000)], new Date(noon));
    assert.equal(added, 0);
  });

  test('writes a time-ordered file', () => {
    store.backfill([sample(noon + 1000), sample(noon)], new Date(noon + 60_000));

    const lines = readFileSync(join(dir, 'samples-2026-08-29.ndjson'), 'utf8').trim().split('\n');
    const times = lines.map((l) => JSON.parse(l).t);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  test('is a no-op for an empty backfill', () => {
    assert.equal(store.backfill([], new Date(noon)), 0);
  });
});

describe('prune', () => {
  test('deletes files outside the retention window and keeps the rest', () => {
    const now = new Date('2026-08-29T12:00:00Z');
    for (const day of ['2026-08-29', '2026-08-16', '2026-08-15', '2026-01-01']) {
      writeFileSync(join(dir, `samples-${day}.ndjson`), '');
    }

    store.prune(now);

    assert.ok(existsSync(join(dir, 'samples-2026-08-29.ndjson')));
    assert.ok(existsSync(join(dir, 'samples-2026-08-16.ndjson')), '14th day back is in range');
    assert.ok(!existsSync(join(dir, 'samples-2026-08-15.ndjson')));
    assert.ok(!existsSync(join(dir, 'samples-2026-01-01.ndjson')));
  });

  test('leaves unrelated files alone', () => {
    writeFileSync(join(dir, 'budget.json'), '{}');
    writeFileSync(join(dir, 'api-calls-2020-01-01.ndjson'), '');

    store.prune(new Date('2026-08-29T12:00:00Z'));

    assert.ok(existsSync(join(dir, 'budget.json')));
    assert.ok(existsSync(join(dir, 'api-calls-2020-01-01.ndjson')), 'the audit log prunes its own files');
  });
});

describe('downsample', () => {
  const base = Date.parse('2026-08-29T00:00:00Z');

  test('returns empty series for no samples', () => {
    assert.deepEqual(downsample([]), { t: [], solarKw: [], loadKw: [], gridKw: [], batteryKw: [], soc: [] });
  });

  test('passes small runs through untouched', () => {
    const samples = [sample(base, { soc: 1 }), sample(base + 90_000, { soc: 2 })];
    const series = downsample(samples, 240);

    assert.deepEqual(series.t, [base, base + 90_000]);
    assert.deepEqual(series.soc, [1, 2]);
  });

  test('reduces a full day to the requested point count', () => {
    // A day at 90s resolution is 960 samples; a 1366px chart cannot show them all.
    const samples = Array.from({ length: 960 }, (_, i) => sample(base + i * 90_000, { solarKw: i / 100 }));
    const series = downsample(samples, 240);

    assert.ok(series.t.length <= 241, `expected ~240 points, got ${series.t.length}`);
    assert.ok(series.t.length > 200);
    assert.deepEqual([...series.t], [...series.t].sort((a, b) => a - b));
  });

  test('averages within a bucket rather than sampling, so peaks survive', () => {
    // One brief spike among flat samples. Picking a representative point would usually miss it.
    const samples = Array.from({ length: 100 }, (_, i) => sample(base + i * 60_000, { solarKw: i === 50 ? 100 : 0 }));
    const series = downsample(samples, 10);

    const peak = Math.max(...series.solarKw.map((v) => v ?? 0));
    assert.ok(peak > 0, 'the spike must still move the line');
  });

  test('inserts a null break across a real outage', () => {
    const samples = [
      sample(base, { soc: 50 }),
      sample(base + 90_000, { soc: 51 }),
      // Two hours offline.
      sample(base + 90_000 + 2 * 3600_000, { soc: 40 }),
    ];
    const series = downsample(samples, 240);

    const nullIndex = series.soc.indexOf(null);
    assert.notEqual(nullIndex, -1, 'an outage must render as a hole, not a line drawn across it');
    assert.deepEqual(series.soc, [50, 51, null, 40]);
    assert.ok(series.t[nullIndex]! > base + 90_000 && series.t[nullIndex]! < base + 90_000 + 2 * 3600_000);
  });

  test('does not break on a normal poll interval', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(base + i * 90_000));
    assert.ok(!downsample(samples, 240).soc.includes(null));
  });

  test('the gap threshold is the boundary', () => {
    const under = [sample(base), sample(base + GAP_THRESHOLD_MS - 1000)];
    const over = [sample(base), sample(base + GAP_THRESHOLD_MS + 1000)];

    assert.ok(!downsample(under, 240).soc.includes(null));
    assert.ok(downsample(over, 240).soc.includes(null));
  });

  test('preserves gaps when bucketing too', () => {
    const many = Array.from({ length: 300 }, (_, i) => sample(base + i * 60_000));
    const afterGap = Array.from({ length: 300 }, (_, i) => sample(base + 300 * 60_000 + 6 * 3600_000 + i * 60_000));
    const series = downsample([...many, ...afterGap], 100);

    assert.ok(series.soc.includes(null), 'downsampled output must still show the outage');
  });

  test('keeps null channels null instead of averaging them to zero', () => {
    const samples = Array.from({ length: 500 }, (_, i) => sample(base + i * 60_000, { batteryKw: null }));
    const series = downsample(samples, 50);

    assert.ok(series.batteryKw.every((v) => v === null), 'an absent battery must not read as 0 kW');
    assert.ok(series.solarKw.every((v) => v === 1));
  });

  test('every channel has the same length as the time axis', () => {
    const samples = Array.from({ length: 700 }, (_, i) => sample(base + i * 90_000));
    const series = downsample(samples, 120);

    for (const key of ['solarKw', 'loadKw', 'gridKw', 'batteryKw', 'soc'] as const) {
      assert.equal(series[key].length, series.t.length, `${key} length must match t`);
    }
  });
});
