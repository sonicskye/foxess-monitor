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

/**
 * How much of the battery is actually available.
 *
 * "Remaining" overstates it. The inverter will not discharge below a minimum SOC, so on a 10.4 kWh
 * pack with a 10% floor, roughly 1 kWh of what the API calls remaining energy can never be used.
 */
export interface BatteryEnergy {
  /** Usable-plus-reserved pack size, kWh. */
  capacityKwh: number | null;
  /** Energy in the pack right now, kWh (the API's `ResidualEnergy`). */
  storedKwh: number | null;
  /** The minimum SOC in force right now, %. */
  floorPercent: number | null;
  /** Energy held below the floor, kWh. Real, but not available to the house. */
  reservedKwh: number | null;
  /** Energy actually available above the floor, kWh. Never negative. */
  usableKwh: number | null;
  /** Percentage points above the floor. Never negative. */
  usablePercent: number | null;
}

const EMPTY_BATTERY_ENERGY: BatteryEnergy = {
  capacityKwh: null,
  storedKwh: null,
  floorPercent: null,
  reservedKwh: null,
  usableKwh: null,
  usablePercent: null,
};

/** Below this SOC the capacity estimate is too noisy to trust — see `deriveCapacityKwh`. */
export const CAPACITY_MIN_SOC = 20;

/** Running state 164 = off-grid, when the reserve is being spent rather than held back. */
const STATE_OFF_GRID = 164;

/**
 * Estimate pack capacity from a live reading: `stored / (soc/100)`.
 *
 * Self-calibrating and in real kWh, unlike the nameplate figure — but SOC arrives as an integer
 * percent, so the division amplifies up to ±0.5% of quantisation error. At 80% that is under 1%;
 * at 10% it is ±5%. Hence the floor: below `CAPACITY_MIN_SOC` this returns null and the caller
 * keeps whatever estimate it already had.
 */
export function deriveCapacityKwh(soc: number | null, storedKwh: number | null): number | null {
  if (soc === null || storedKwh === null) return null;
  if (!Number.isFinite(soc) || !Number.isFinite(storedKwh)) return null;
  if (soc < CAPACITY_MIN_SOC || storedKwh <= 0) return null;
  return storedKwh / (soc / 100);
}

/**
 * Read the nameplate pack size out of `device/detail`'s `batteryList`.
 *
 * The field is `capicty` — the API's own misspelling — typed as a string with **undocumented
 * units**. Values are summed across modules, then interpreted by magnitude, which is unavoidably a
 * heuristic: domestic packs are single-digit-to-low-tens of kWh, so anything above ~200 is read as
 * watt-hours and anything absurd is rejected outright rather than shown as a wrong pack size.
 *
 * This is only a seed. Once telemetry gives a reading above `CAPACITY_MIN_SOC`,
 * `deriveCapacityKwh` supersedes it with a real, self-calibrating figure.
 */
export function parseNameplateCapacityKwh(
  batteryList: { capicty?: string | number }[] | undefined,
): number | null {
  if (!batteryList?.length) return null;

  let total = 0;
  for (const battery of batteryList) {
    const raw = typeof battery.capicty === 'number' ? battery.capicty : Number(battery.capicty);
    if (Number.isFinite(raw) && raw > 0) total += raw;
  }
  if (total <= 0) return null;

  // > 200 is implausible as kWh for a house, so treat it as Wh.
  const kwh = total > 200 ? total / 1000 : total;
  // Reject anything still outside the range a domestic battery could occupy.
  return kwh >= 0.5 && kwh <= 200 ? kwh : null;
}

/**
 * Work out stored / usable / reserved energy.
 *
 * Which floor applies depends on the inverter's state. On-grid the pack is held back to
 * `minSocOnGrid` so that a power cut has something to run on; off-grid that reserve is exactly what
 * is being spent, and the real floor is the lower `minSoc`.
 *
 * Every field is independently nullable: a grid-tied inverter has none of this, and the UI must
 * render a missing figure as "—" rather than as zero.
 */
export function batteryEnergy(input: {
  soc: number | null;
  residualKwh: number | null;
  /** Best available capacity estimate, kWh. */
  capacityKwh: number | null;
  minSoc: number | null;
  minSocOnGrid: number | null;
  runningState: number | null;
}): BatteryEnergy {
  const { soc, residualKwh, capacityKwh, minSoc, minSocOnGrid, runningState } = input;

  const stored = Number.isFinite(residualKwh as number) ? residualKwh : null;
  const capacity =
    capacityKwh !== null && Number.isFinite(capacityKwh) && capacityKwh > 0 ? capacityKwh : null;

  // Off-grid spends the reserve, so the floor drops to minSoc. Either value alone is used as-is.
  const offGrid = runningState === STATE_OFF_GRID;
  const preferred = offGrid ? minSoc : minSocOnGrid;
  const fallback = offGrid ? minSocOnGrid : minSoc;
  const rawFloor = preferred ?? fallback;
  const floor =
    rawFloor !== null && Number.isFinite(rawFloor) ? Math.max(0, Math.min(100, rawFloor)) : null;

  if (floor === null) {
    // No floor known: report what we have, but never claim a usable figure we cannot compute.
    return { ...EMPTY_BATTERY_ENERGY, capacityKwh: capacity, storedKwh: stored };
  }

  const reserved = capacity === null ? null : capacity * (floor / 100);
  // Clamped: SOC can sit below the floor after an outage, or right after the owner raises it.
  const usableKwh = stored === null || reserved === null ? null : Math.max(0, stored - reserved);
  const usablePercent = soc === null || !Number.isFinite(soc) ? null : Math.max(0, soc - floor);

  return {
    capacityKwh: capacity,
    storedKwh: stored,
    floorPercent: floor,
    reservedKwh: reserved,
    usableKwh,
    usablePercent,
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
