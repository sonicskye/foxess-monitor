/**
 * Intraday sample storage.
 *
 * The live poll already runs every 90 seconds, so today's chart is a by-product of data we have
 * paid for anyway. Samples are appended to one NDJSON file per local day; the chart is served from
 * that file. `history/query` is called only once, at startup, to backfill from local midnight so a
 * restart doesn't leave a truncated graph. See docs/DECISIONS.md §3.
 *
 * Append-only, one file per day: pruning is an unlink and a power cut costs at most the last line.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './log.ts';
import type { Sample } from './normalize.ts';
import { dayKey, isExpired, startOfLocalDay } from './localdate.ts';

const PREFIX = 'samples-';
const SUFFIX = '.ndjson';

export interface SampleStore {
  append(sample: Sample): void;
  /** Samples for the local day containing `at`, ascending by time. */
  readDay(at?: Date): Sample[];
  /** Merge backfilled samples with what's on disk, de-duplicated by timestamp. */
  backfill(samples: Sample[], at?: Date): number;
  prune(at?: Date): void;
}

export function createSampleStore(opts: {
  dir: string;
  timeZone: string;
  retainDays: number;
  log: Logger;
}): SampleStore {
  const { dir, timeZone, retainDays, log } = opts;
  mkdirSync(dir, { recursive: true });

  const fileFor = (at: Date): string => join(dir, `${PREFIX}${dayKey(at, timeZone)}${SUFFIX}`);

  function read(at: Date): Sample[] {
    let raw: string;
    try {
      raw = readFileSync(fileFor(at), 'utf8');
    } catch {
      return []; // no samples yet today
    }

    const out: Sample[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as Sample;
        if (typeof parsed.t === 'number' && Number.isFinite(parsed.t)) out.push(parsed);
      } catch {
        // A torn final line from a power cut mid-append. Skip it; the rest of the day is intact —
        // which is the whole reason this is append-only.
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  return {
    append(sample) {
      try {
        appendFileSync(fileFor(new Date(sample.t)), JSON.stringify(sample) + '\n');
      } catch (err) {
        log.warn('could not append sample', { err });
      }
    },

    readDay(at = new Date()) {
      return read(at);
    },

    backfill(samples, at = new Date()) {
      if (samples.length === 0) return 0;

      const dayStart = startOfLocalDay(at, timeZone);
      const existing = read(at);
      const seen = new Set(existing.map((s) => s.t));

      // Only today's samples, and only ones we don't already hold.
      const fresh = samples.filter((s) => s.t >= dayStart && s.t <= at.getTime() && !seen.has(s.t));
      if (fresh.length === 0) return 0;

      const merged = [...existing, ...fresh].sort((a, b) => a.t - b.t);
      try {
        // Rewritten rather than appended so the file stays time-ordered. This happens once at
        // startup, never during steady-state polling.
        writeFileSync(fileFor(at), merged.map((s) => JSON.stringify(s)).join('\n') + '\n');
      } catch (err) {
        log.warn('could not write backfilled samples', { err });
        return 0;
      }
      return fresh.length;
    },

    prune(at = new Date()) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch (err) {
        log.warn('could not read data dir for pruning', { dir, err });
        return;
      }
      for (const name of entries) {
        if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
        const key = name.slice(PREFIX.length, -SUFFIX.length);
        if (!isExpired(key, at, timeZone, retainDays)) continue;
        try {
          unlinkSync(join(dir, name));
          log.debug('pruned expired sample file', { file: name });
        } catch (err) {
          log.warn('could not prune sample file', { file: name, err });
        }
      }
    },
  };
}

/** A gap longer than this is a real outage and is rendered as a break, never bridged. */
export const GAP_THRESHOLD_MS = 10 * 60_000;

export interface Series {
  t: number[];
  solarKw: (number | null)[];
  loadKw: (number | null)[];
  gridKw: (number | null)[];
  batteryKw: (number | null)[];
  soc: (number | null)[];
}

const CHANNELS = ['solarKw', 'loadKw', 'gridKw', 'batteryKw', 'soc'] as const;

/**
 * Reduce samples to at most `maxPoints` buckets for the client.
 *
 * A day at 90-second resolution is 960 samples; a 1366px-wide chart cannot show more than a few
 * hundred. Buckets are averaged rather than sampled so a brief peak still moves the line instead of
 * being dropped entirely by whichever point happened to be picked.
 *
 * Gaps are preserved: a bucket with no samples emits nulls, and any gap longer than
 * GAP_THRESHOLD_MS gets an explicit null break, so an outage renders as a hole rather than a
 * straight line drawn across hours the inverter was offline.
 */
export function downsample(samples: Sample[], maxPoints = 240): Series {
  const empty: Series = { t: [], solarKw: [], loadKw: [], gridKw: [], batteryKw: [], soc: [] };
  if (samples.length === 0) return empty;

  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const withBreaks: (Sample | null)[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const sample = sorted[i]!;
    const previous = sorted[i - 1];
    if (previous && sample.t - previous.t > GAP_THRESHOLD_MS) withBreaks.push(null);
    withBreaks.push(sample);
  }

  if (withBreaks.length <= maxPoints) {
    const series: Series = { t: [], solarKw: [], loadKw: [], gridKw: [], batteryKw: [], soc: [] };
    let lastT = sorted[0]!.t;
    for (const entry of withBreaks) {
      if (entry === null) {
        // Midpoint of the gap, so the break sits where the outage actually was.
        series.t.push(lastT + GAP_THRESHOLD_MS / 2);
        for (const key of CHANNELS) series[key].push(null);
        continue;
      }
      lastT = entry.t;
      series.t.push(entry.t);
      for (const key of CHANNELS) series[key].push(entry[key]);
    }
    return series;
  }

  const first = sorted[0]!.t;
  const last = sorted.at(-1)!.t;
  const span = Math.max(1, last - first);
  const bucketMs = span / maxPoints;

  const buckets: { sum: Record<string, number>; count: Record<string, number>; tSum: number; n: number }[] =
    Array.from({ length: maxPoints + 1 }, () => ({
      sum: { solarKw: 0, loadKw: 0, gridKw: 0, batteryKw: 0, soc: 0 },
      count: { solarKw: 0, loadKw: 0, gridKw: 0, batteryKw: 0, soc: 0 },
      tSum: 0,
      n: 0,
    }));

  for (const sample of sorted) {
    const index = Math.min(buckets.length - 1, Math.floor((sample.t - first) / bucketMs));
    const bucket = buckets[index]!;
    bucket.tSum += sample.t;
    bucket.n += 1;
    for (const key of CHANNELS) {
      const value = sample[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        bucket.sum[key]! += value;
        bucket.count[key]! += 1;
      }
    }
  }

  const series: Series = { t: [], solarKw: [], loadKw: [], gridKw: [], batteryKw: [], soc: [] };
  let previousT: number | null = null;

  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i]!;
    if (bucket.n === 0) continue; // an empty bucket is a gap, handled below

    const t = Math.round(bucket.tSum / bucket.n);
    if (previousT !== null && t - previousT > GAP_THRESHOLD_MS) {
      series.t.push(previousT + Math.round((t - previousT) / 2));
      for (const key of CHANNELS) series[key].push(null);
    }
    previousT = t;

    series.t.push(t);
    for (const key of CHANNELS) {
      series[key].push(bucket.count[key]! === 0 ? null : bucket.sum[key]! / bucket.count[key]!);
    }
  }

  return series;
}
