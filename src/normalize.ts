/**
 * Raw FoxESS variables → the `Snapshot` the rest of the app uses.
 *
 * This is the boundary where the API's several different conventions become one. It matters
 * because the API represents each flow more than one way:
 *
 *   - Battery: `invBatPower` is signed POSITIVE ON DISCHARGE, and the same value also appears
 *     split into two always-positive series, `batChargePower` / `batDischargePower`.
 *   - Grid: only ever split, into `gridConsumptionPower` (import) and `feedinPower` (export).
 *     There is no signed equivalent.
 *
 * Leaving that to the UI would scatter sign logic across components and eventually flip an arrow.
 * So both collapse here into a single signed number, with the SAME convention:
 *
 *   **positive = energy flowing INTO the thing named.**
 *
 *   `batteryKw` > 0  → charging      `gridKw` > 0  → importing
 *   `batteryKw` < 0  → discharging   `gridKw` < 0  → exporting
 *
 * Note that this makes `batteryKw` the negation of `invBatPower`. That is deliberate — see
 * docs/DECISIONS.md §4.
 */

import type { RealDatum, RealResult } from './foxess/types.ts';

/** How long an inverter reading may be before the display must stop calling it live. */
export const STALE_AFTER_MS = 10 * 60_000;

export interface Snapshot {
  /** When we received it. */
  ts: string;
  deviceSN: string;

  /** PV generation, kW. Never negative. */
  solarKw: number | null;
  /** House consumption, kW. */
  loadKw: number | null;
  /** Signed: positive importing, negative exporting. */
  gridKw: number | null;
  /** Signed: positive charging, negative discharging. */
  batteryKw: number | null;
  /** Inverter AC output, kW. */
  generationKw: number | null;
  /** Backup/EPS output, kW. */
  epsKw: number | null;

  /** Battery state of charge, %. */
  soc: number | null;
  /** Battery state of health, %. */
  soh: number | null;
  /** Energy left in the battery, kWh. */
  residualKwh: number | null;
  batteryTempC: number | null;
  ambientTempC: number | null;
  runningState: number | null;

  /** The inverter's own clock, as reported. Null when it didn't say. */
  inverterTime: string | null;
  /** `inverterTime` parsed to epoch ms, or null if absent/unparseable. */
  inverterTimeMs: number | null;
  /**
   * True when the reading is older than STALE_AFTER_MS, or the inverter gave no time at all.
   * A wall display must never present stale numbers as live.
   */
  stale: boolean;
}

/** One stored sample — the Snapshot fields worth charting, and nothing else. */
export interface Sample {
  /** Epoch ms. */
  t: number;
  solarKw: number | null;
  loadKw: number | null;
  gridKw: number | null;
  batteryKw: number | null;
  soc: number | null;
}

function toNumber(value: RealDatum['value'] | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the inverter's clock: `yyyy-MM-dd HH:mm:ss zZ`, e.g. `2026-08-29 14:32:01 GMT+1`.
 *
 * `Date.parse` does not reliably handle that shape, so the offset is extracted and applied by hand.
 * Returns null rather than a wrong instant — a bad timestamp must read as "unknown", which the
 * staleness check treats as stale, not as "now".
 */
export function parseInverterTime(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(.*)$/.exec(raw.trim());
  if (!m) return null;

  const [, y, mo, d, h, mi, s, zoneRaw] = m;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));

  const zone = (zoneRaw ?? '').trim();
  if (zone === '') return base; // no zone given: treat as UTC

  // `GMT+1`, `UTC-03:30`, `+0100`, `Z`
  const offset = /(?:GMT|UTC)?\s*([+-])(\d{1,2}):?(\d{2})?$/.exec(zone);
  if (offset) {
    const [, sign, hours, minutes] = offset;
    const delta = (Number(hours) * 60 + Number(minutes ?? 0)) * 60_000;
    return sign === '+' ? base - delta : base + delta;
  }
  if (/^(GMT|UTC|Z)$/i.test(zone)) return base;

  return base;
}

/**
 * Collapse the two split series into one signed value.
 *
 * Both halves are reported as positive numbers, so the result is `into - outOf`. When neither is
 * present the caller supplies a fallback (for the battery, the negation of `invBatPower`).
 */
function combineSigned(into: number | null, outOf: number | null, fallback: number | null): number | null {
  if (into === null && outOf === null) return fallback;
  return (into ?? 0) - (outOf ?? 0);
}

export function normalizeSnapshot(
  result: RealResult,
  opts: { now?: number; staleAfterMs?: number } = {},
): Snapshot {
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;

  const byName = new Map(result.datas.map((d) => [d.variable, d]));
  const num = (name: string): number | null => toNumber(byName.get(name)?.value);

  // `invBatPower` is positive on DISCHARGE, so negating it gives positive-on-charge.
  const invBatPower = num('invBatPower');
  const batteryKw = combineSigned(
    num('batChargePower'),
    num('batDischargePower'),
    invBatPower === null ? null : -invBatPower,
  );

  const gridKw = combineSigned(num('gridConsumptionPower'), num('feedinPower'), null);

  const inverterTime = result.datas.find((d) => d.time)?.time ?? null;
  const inverterTimeMs = parseInverterTime(inverterTime);

  return {
    ts: new Date(now).toISOString(),
    deviceSN: result.deviceSN,

    solarKw: num('pvPower'),
    loadKw: num('loadsPower'),
    gridKw,
    batteryKw,
    generationKw: num('generationPower'),
    epsKw: num('epsPower'),

    soc: num('SoC'),
    soh: num('SOH'),
    residualKwh: num('ResidualEnergy'),
    batteryTempC: num('batTemperature'),
    ambientTempC: num('ambientTemperation'), // sic — the API's spelling
    runningState: num('runningState'),

    inverterTime,
    inverterTimeMs,
    // No timestamp means we cannot prove the reading is current, so treat it as stale.
    stale: inverterTimeMs === null || now - inverterTimeMs > staleAfterMs,
  };
}

export function toSample(snapshot: Snapshot): Sample {
  return {
    t: Date.parse(snapshot.ts),
    solarKw: snapshot.solarKw,
    loadKw: snapshot.loadKw,
    gridKw: snapshot.gridKw,
    batteryKw: snapshot.batteryKw,
    soc: snapshot.soc,
  };
}

/** Today's energy totals, in kWh. */
export interface DayTotals {
  solarKwh: number | null;
  loadKwh: number | null;
  importKwh: number | null;
  exportKwh: number | null;
  batteryChargedKwh: number | null;
  batteryDischargedKwh: number | null;
  /** Inverter AC output — not the same as solar, since it includes battery discharge. */
  generationKwh: number | null;
}

function sumSeries(series: { variable: string; values: (number | null)[] }[], name: string): number | null {
  const found = series.find((s) => s.variable === name);
  if (!found) return null;
  const values = found.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Sum a `dimension: 'day'` report into day totals.
 *
 * Each series holds one value per hour elapsed so far, so this is a plain sum. `PVEnergyTotal` is
 * preferred for solar and `generation` used as the fallback — the two differ because `generation`
 * is AC output and therefore includes energy that came out of the battery.
 */
export function normalizeDayTotals(
  series: { variable: string; values: (number | null)[] }[],
): DayTotals {
  return {
    solarKwh: sumSeries(series, 'PVEnergyTotal') ?? sumSeries(series, 'generation'),
    loadKwh: sumSeries(series, 'loads'),
    importKwh: sumSeries(series, 'gridConsumption'),
    exportKwh: sumSeries(series, 'feedin'),
    batteryChargedKwh: sumSeries(series, 'chargeEnergyToTal'), // sic
    batteryDischargedKwh: sumSeries(series, 'dischargeEnergyToTal'), // sic
    generationKwh: sumSeries(series, 'generation'),
  };
}

/** Convert a history/query response into samples, for the startup backfill. */
export function normalizeHistory(
  datas: { variable: string; data: { time: string; value: number }[] }[],
): Sample[] {
  const byTime = new Map<number, Sample>();

  const put = (variable: string, key: keyof Omit<Sample, 't'>, negate = false): void => {
    const series = datas.find((d) => d.variable === variable);
    if (!series) return;

    for (const point of series.data) {
      const t = parseInverterTime(point.time);
      if (t === null || !Number.isFinite(point.value)) continue;

      let sample = byTime.get(t);
      if (!sample) {
        sample = { t, solarKw: null, loadKw: null, gridKw: null, batteryKw: null, soc: null };
        byTime.set(t, sample);
      }
      const value = negate ? -point.value : point.value;
      sample[key] = (sample[key] ?? 0) + value;
    }
  };

  put('pvPower', 'solarKw');
  put('loadsPower', 'loadKw');
  put('SoC', 'soc');
  // Same sign conventions as the live path: into the thing is positive.
  put('gridConsumptionPower', 'gridKw');
  put('feedinPower', 'gridKw', true);
  put('batChargePower', 'batteryKw');
  put('batDischargePower', 'batteryKw', true);

  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
