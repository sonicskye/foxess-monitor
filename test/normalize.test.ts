import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPACITY_MIN_SOC,
  STALE_AFTER_MS,
  batteryEnergy,
  deriveCapacityKwh,
  normalizeDayTotals,
  normalizeHistory,
  normalizeSnapshot,
  parseInverterTime,
  toSample,
} from '../src/normalize.ts';
import type { RealResult } from '../src/foxess/types.ts';

const NOW = Date.parse('2026-08-29T13:32:30Z');
const FRESH = '2026-08-29 14:32:01 GMT+1'; // == 13:32:01Z, 29s before NOW

function real(vars: Record<string, number | string>, time = FRESH): RealResult {
  return {
    deviceSN: 'SN123',
    datas: Object.entries(vars).map(([variable, value]) => ({ variable, value, time })),
  };
}

describe('battery sign convention — positive is charging', () => {
  test('charging from the split series is positive', () => {
    const s = normalizeSnapshot(real({ batChargePower: 2.4, batDischargePower: 0 }), { now: NOW });
    assert.equal(s.batteryKw, 2.4);
  });

  test('discharging from the split series is negative', () => {
    const s = normalizeSnapshot(real({ batChargePower: 0, batDischargePower: 1.8 }), { now: NOW });
    assert.equal(s.batteryKw, -1.8);
  });

  test('falls back to invBatPower, NEGATED — the API signs it positive on discharge', () => {
    // This is the inversion most likely to be "fixed" into a bug. invBatPower = +1.8 means the
    // battery is DIScharging, which in our convention is -1.8.
    const discharging = normalizeSnapshot(real({ invBatPower: 1.8 }), { now: NOW });
    assert.equal(discharging.batteryKw, -1.8);

    const charging = normalizeSnapshot(real({ invBatPower: -2.4 }), { now: NOW });
    assert.equal(charging.batteryKw, 2.4);
  });

  test('prefers the split series over invBatPower when both are present', () => {
    const s = normalizeSnapshot(
      real({ batChargePower: 2.0, batDischargePower: 0, invBatPower: -2.0 }),
      { now: NOW },
    );
    assert.equal(s.batteryKw, 2.0);
  });

  test('is null when the inverter reports no battery at all', () => {
    const s = normalizeSnapshot(real({ pvPower: 3.1 }), { now: NOW });
    assert.equal(s.batteryKw, null, 'a grid-tied inverter must not read as 0 kW battery');
  });

  test('treats a single present half as authoritative', () => {
    const s = normalizeSnapshot(real({ batDischargePower: 1.2 }), { now: NOW });
    assert.equal(s.batteryKw, -1.2);
  });
});

describe('grid sign convention — positive is importing', () => {
  test('importing is positive', () => {
    const s = normalizeSnapshot(real({ gridConsumptionPower: 1.4, feedinPower: 0 }), { now: NOW });
    assert.equal(s.gridKw, 1.4);
  });

  test('exporting is negative', () => {
    const s = normalizeSnapshot(real({ gridConsumptionPower: 0, feedinPower: 2.1 }), { now: NOW });
    assert.equal(s.gridKw, -2.1);
  });

  test('is null when neither half is reported', () => {
    const s = normalizeSnapshot(real({ pvPower: 1 }), { now: NOW });
    assert.equal(s.gridKw, null);
  });

  test('battery and grid share the same "into the thing is positive" rule', () => {
    const s = normalizeSnapshot(
      real({ gridConsumptionPower: 1.0, feedinPower: 0, batChargePower: 1.0, batDischargePower: 0 }),
      { now: NOW },
    );
    assert.ok(s.gridKw! > 0 && s.batteryKw! > 0, 'both flowing IN must both be positive');
  });
});

describe('field mapping', () => {
  test('maps the documented variables, misspellings included', () => {
    const s = normalizeSnapshot(
      real({
        pvPower: 3.24,
        loadsPower: 1.08,
        generationPower: 3.2,
        epsPower: 0,
        SoC: 74,
        SOH: 99,
        ResidualEnergy: 9.1,
        batTemperature: 18.4,
        ambientTemperation: 21.5, // sic
        runningState: 1,
      }),
      { now: NOW },
    );

    assert.equal(s.solarKw, 3.24);
    assert.equal(s.loadKw, 1.08);
    assert.equal(s.generationKw, 3.2);
    assert.equal(s.epsKw, 0);
    assert.equal(s.soc, 74);
    assert.equal(s.soh, 99);
    assert.equal(s.residualKwh, 9.1);
    assert.equal(s.batteryTempC, 18.4);
    assert.equal(s.ambientTempC, 21.5);
    assert.equal(s.runningState, 1);
    assert.equal(s.deviceSN, 'SN123');
  });

  test('coerces string values the API sometimes sends', () => {
    const s = normalizeSnapshot(real({ SoC: '74', pvPower: '3.5' }), { now: NOW });
    assert.equal(s.soc, 74);
    assert.equal(s.solarKw, 3.5);
  });

  test('missing variables are null, never zero', () => {
    // The distinction matters: 0 kW solar at noon is a fault; "not reported" is a grid-tied unit.
    const s = normalizeSnapshot(real({ pvPower: 1 }), { now: NOW });
    assert.equal(s.soc, null);
    assert.equal(s.residualKwh, null);
    assert.equal(s.loadKw, null);
  });

  test('a non-numeric value becomes null rather than NaN', () => {
    const s = normalizeSnapshot(real({ SoC: 'n/a' }), { now: NOW });
    assert.equal(s.soc, null);
  });
});

describe('staleness', () => {
  test('a recent reading is not stale', () => {
    const s = normalizeSnapshot(real({ SoC: 74 }, FRESH), { now: NOW });
    assert.equal(s.stale, false);
    assert.equal(s.inverterTime, FRESH);
  });

  test('a reading older than the window is stale', () => {
    const s = normalizeSnapshot(real({ SoC: 74 }, '2026-08-29 13:00:00 GMT+1'), { now: NOW });
    assert.equal(s.stale, true);
  });

  test('no timestamp at all is treated as stale, not as now', () => {
    // The safe direction: we cannot prove it is current, so the display must not claim it is.
    const s = normalizeSnapshot({ deviceSN: 'SN', datas: [{ variable: 'SoC', value: 74 }] }, { now: NOW });
    assert.equal(s.stale, true);
    assert.equal(s.inverterTimeMs, null);
  });

  test('an unparseable timestamp is stale rather than a wrong instant', () => {
    const s = normalizeSnapshot(real({ SoC: 74 }, 'yesterday-ish'), { now: NOW });
    assert.equal(s.stale, true);
    assert.equal(s.inverterTimeMs, null);
  });

  test('the boundary is STALE_AFTER_MS', () => {
    const base = Date.parse('2026-08-29T12:00:00Z');
    const at = (offset: number) =>
      normalizeSnapshot(real({ SoC: 1 }, '2026-08-29 12:00:00 GMT'), { now: base + offset }).stale;

    assert.equal(at(STALE_AFTER_MS - 1000), false);
    assert.equal(at(STALE_AFTER_MS + 1000), true);
  });
});

describe('parseInverterTime', () => {
  test('parses the documented format with a GMT offset', () => {
    assert.equal(parseInverterTime('2026-08-29 14:32:01 GMT+1'), Date.parse('2026-08-29T13:32:01Z'));
  });

  test('parses a negative offset', () => {
    assert.equal(parseInverterTime('2026-08-29 08:32:01 GMT-5'), Date.parse('2026-08-29T13:32:01Z'));
  });

  test('parses a half-hour offset', () => {
    assert.equal(parseInverterTime('2026-08-29 19:02:01 UTC+05:30'), Date.parse('2026-08-29T13:32:01Z'));
  });

  test('parses a compact numeric offset', () => {
    assert.equal(parseInverterTime('2026-08-29 14:32:01 +0100'), Date.parse('2026-08-29T13:32:01Z'));
  });

  test('treats a missing zone as UTC', () => {
    assert.equal(parseInverterTime('2026-08-29 13:32:01'), Date.parse('2026-08-29T13:32:01Z'));
  });

  test('returns null for junk, empty and undefined', () => {
    assert.equal(parseInverterTime('not a date'), null);
    assert.equal(parseInverterTime(''), null);
    assert.equal(parseInverterTime(undefined), null);
    assert.equal(parseInverterTime(null), null);
  });
});

describe('toSample', () => {
  test('keeps the chartable channels and the timestamp', () => {
    const snapshot = normalizeSnapshot(
      real({ pvPower: 3.2, loadsPower: 1.1, gridConsumptionPower: 0, feedinPower: 2.1, SoC: 74 }),
      { now: NOW },
    );
    assert.deepEqual(toSample(snapshot), {
      t: NOW,
      solarKw: 3.2,
      loadKw: 1.1,
      gridKw: -2.1,
      batteryKw: null,
      soc: 74,
    });
  });
});

describe('deriveCapacityKwh', () => {
  test('recovers pack size from a live reading', () => {
    assert.equal(deriveCapacityKwh(74, 7.696)?.toFixed(1), '10.4');
    assert.equal(deriveCapacityKwh(100, 10.4), 10.4);
  });

  test('refuses to divide near empty, where integer SOC makes it unreliable', () => {
    // At 10% SOC, a ±0.5% quantisation error is ±5% of the answer. Better to keep the previous
    // estimate than to publish a wrong pack size.
    assert.equal(deriveCapacityKwh(10, 1.04), null);
    assert.equal(deriveCapacityKwh(CAPACITY_MIN_SOC - 1, 2), null);
    assert.equal(deriveCapacityKwh(CAPACITY_MIN_SOC, 2.08)?.toFixed(1), '10.4');
  });

  test('returns null rather than Infinity or NaN on missing or zero input', () => {
    assert.equal(deriveCapacityKwh(0, 5), null);
    assert.equal(deriveCapacityKwh(50, 0), null);
    assert.equal(deriveCapacityKwh(null, 5), null);
    assert.equal(deriveCapacityKwh(50, null), null);
    assert.equal(deriveCapacityKwh(NaN, 5), null);
  });
});

describe('batteryEnergy', () => {
  const PACK = { soc: 74, residualKwh: 7.7, capacityKwh: 10.4, minSoc: 10, minSocOnGrid: 20 };

  test('usable is what sits above the floor, not everything stored', () => {
    // The whole point: "7.7 kWh remaining" overstates what the house can actually draw.
    const e = batteryEnergy({ ...PACK, runningState: 163 });

    assert.equal(e.floorPercent, 20, 'on-grid holds back to minSocOnGrid');
    assert.equal(e.reservedKwh?.toFixed(2), '2.08');
    assert.equal(e.usableKwh?.toFixed(2), '5.62');
    assert.equal(e.usablePercent, 54);
    assert.equal(e.storedKwh, 7.7);
  });

  test('off-grid drops to the lower floor, because the reserve is what is being spent', () => {
    const e = batteryEnergy({ ...PACK, runningState: 164 });

    assert.equal(e.floorPercent, 10, 'off-grid uses minSoc');
    assert.equal(e.reservedKwh?.toFixed(2), '1.04');
    assert.equal(e.usableKwh?.toFixed(2), '6.66');
    assert.equal(e.usablePercent, 64);
  });

  test('a power cut increases usable energy without the pack changing', () => {
    const onGrid = batteryEnergy({ ...PACK, runningState: 163 });
    const offGrid = batteryEnergy({ ...PACK, runningState: 164 });

    assert.ok(offGrid.usableKwh! > onGrid.usableKwh!);
    assert.equal(offGrid.storedKwh, onGrid.storedKwh, 'stored energy is unchanged');
  });

  test('clamps at zero when SOC is below the floor', () => {
    // Happens after an outage, or the moment the owner raises the floor above current charge.
    const e = batteryEnergy({
      soc: 8, residualKwh: 0.83, capacityKwh: 10.4, minSoc: 10, minSocOnGrid: 20, runningState: 163,
    });

    assert.equal(e.usableKwh, 0, 'never negative');
    assert.equal(e.usablePercent, 0);
    assert.equal(e.storedKwh, 0.83, 'the energy is still really in there');
  });

  test('falls back to whichever floor is known', () => {
    const onlyMinSoc = batteryEnergy({ ...PACK, minSocOnGrid: null, runningState: 163 });
    assert.equal(onlyMinSoc.floorPercent, 10);

    const onlyOnGrid = batteryEnergy({ ...PACK, minSoc: null, runningState: 164 });
    assert.equal(onlyOnGrid.floorPercent, 20);
  });

  test('with no floor known, reports stored but claims no usable figure', () => {
    const e = batteryEnergy({ ...PACK, minSoc: null, minSocOnGrid: null, runningState: 163 });

    assert.equal(e.storedKwh, 7.7);
    assert.equal(e.capacityKwh, 10.4);
    assert.equal(e.floorPercent, null);
    assert.equal(e.usableKwh, null, 'better to show nothing than to guess a floor of 0');
    assert.equal(e.reservedKwh, null);
  });

  test('a grid-tied inverter yields all nulls, never zeros', () => {
    const e = batteryEnergy({
      soc: null, residualKwh: null, capacityKwh: null, minSoc: null, minSocOnGrid: null,
      runningState: 163,
    });

    assert.deepEqual(e, {
      capacityKwh: null, storedKwh: null, floorPercent: null,
      reservedKwh: null, usableKwh: null, usablePercent: null,
    });
  });

  test('kWh figures do NOT need a capacity estimate', () => {
    // Regression: usable used to be `stored − capacity × floor/100`, so an unknown pack size — a
    // restart on a low battery with no nameplate — showed "usable —" even with the floor known.
    // The capacity term cancels, so stored/soc/floor alone are enough.
    const e = batteryEnergy({ ...PACK, capacityKwh: null, runningState: 163 });

    assert.equal(e.usablePercent, 54);
    assert.equal(e.usableKwh?.toFixed(2), '5.62', 'same answer as with a known capacity');
    assert.equal(e.reservedKwh?.toFixed(2), '2.08');
    assert.equal(e.capacityKwh, null, 'capacity itself is still unknown, and reported as such');
  });

  test('the derived figures agree with the capacity-based ones', () => {
    const withCapacity = batteryEnergy({ ...PACK, runningState: 163 });
    const without = batteryEnergy({ ...PACK, capacityKwh: null, runningState: 163 });

    assert.equal(withCapacity.usableKwh?.toFixed(4), without.usableKwh?.toFixed(4));
    assert.equal(withCapacity.reservedKwh?.toFixed(4), without.reservedKwh?.toFixed(4));
  });

  test('falls back to the capacity form at 0% SOC, where the division is undefined', () => {
    const e = batteryEnergy({
      soc: 0, residualKwh: 0, capacityKwh: 10.4, minSoc: 10, minSocOnGrid: 20, runningState: 163,
    });

    assert.equal(e.reservedKwh?.toFixed(2), '2.08');
    assert.equal(e.usableKwh, 0);
    assert.equal(e.usablePercent, 0);
  });

  test('an empty pack with no capacity yields nulls, not a divide by zero', () => {
    const e = batteryEnergy({
      soc: 0, residualKwh: 0, capacityKwh: null, minSoc: 10, minSocOnGrid: 20, runningState: 163,
    });

    assert.equal(e.reservedKwh, null);
    assert.equal(e.usableKwh, null);
    assert.ok(!Number.isNaN(e.usableKwh as number));
  });

  test('reserved never exceeds what is actually stored', () => {
    // Below the floor, the pack does not hold the full reserve — claiming it does would imply
    // energy that is not there.
    const e = batteryEnergy({
      soc: 8, residualKwh: 0.83, capacityKwh: null, minSoc: 10, minSocOnGrid: 20, runningState: 163,
    });

    assert.ok(e.reservedKwh! <= 0.83 + 1e-9, `reserved ${e.reservedKwh} exceeds stored 0.83`);
    assert.equal(e.usableKwh, 0);
  });

  test('a zero floor means everything stored is usable', () => {
    const e = batteryEnergy({ ...PACK, minSoc: 0, minSocOnGrid: 0, runningState: 163 });

    assert.equal(e.reservedKwh, 0);
    assert.equal(e.usableKwh, 7.7);
    assert.equal(e.usablePercent, 74);
  });

  test('an out-of-range floor is clamped rather than trusted', () => {
    assert.equal(batteryEnergy({ ...PACK, minSocOnGrid: 140, runningState: 163 }).floorPercent, 100);
    assert.equal(batteryEnergy({ ...PACK, minSocOnGrid: -5, runningState: 163 }).floorPercent, 0);
  });

  test('a full pack at a 20% floor still reserves a fifth of it', () => {
    const e = batteryEnergy({
      soc: 100, residualKwh: 10.4, capacityKwh: 10.4, minSoc: 10, minSocOnGrid: 20, runningState: 163,
    });
    assert.equal(e.usableKwh?.toFixed(2), '8.32');
    assert.equal(e.usablePercent, 80);
  });
});

describe('normalizeDayTotals', () => {
  const series = [
    { variable: 'PVEnergyTotal', values: [0, 0, 1.5, 3.2, 4.1] },
    { variable: 'generation', values: [0, 0.2, 1.4, 3.0, 3.9] },
    { variable: 'loads', values: [0.4, 0.4, 0.5, 0.6, 0.5] },
    { variable: 'gridConsumption', values: [0.4, 0.4, 0, 0, 0] },
    { variable: 'feedin', values: [0, 0, 1.0, 2.4, 3.2] },
    { variable: 'chargeEnergyToTal', values: [0, 0, 0.5, 0.8, 0.9] },
    { variable: 'dischargeEnergyToTal', values: [0.2, 0.2, 0, 0, 0] },
  ];

  test('sums each hourly series', () => {
    const totals = normalizeDayTotals(series);
    assert.equal(totals.solarKwh?.toFixed(2), '8.80');
    assert.equal(totals.loadKwh?.toFixed(2), '2.40');
    assert.equal(totals.importKwh?.toFixed(2), '0.80');
    assert.equal(totals.exportKwh?.toFixed(2), '6.60');
    assert.equal(totals.batteryChargedKwh?.toFixed(2), '2.20');
    assert.equal(totals.batteryDischargedKwh?.toFixed(2), '0.40');
  });

  test('prefers PVEnergyTotal over generation for solar', () => {
    // generation is AC output and includes battery discharge, so it is not the solar figure.
    const totals = normalizeDayTotals(series);
    assert.notEqual(totals.solarKwh, totals.generationKwh);
    assert.equal(totals.generationKwh?.toFixed(2), '8.50');
  });

  test('falls back to generation when PVEnergyTotal is absent', () => {
    const totals = normalizeDayTotals(series.filter((s) => s.variable !== 'PVEnergyTotal'));
    assert.equal(totals.solarKwh?.toFixed(2), '8.50');
  });

  test('ignores nulls inside a series', () => {
    assert.equal(normalizeDayTotals([{ variable: 'loads', values: [1, null, 2] }]).loadKwh, 3);
  });

  test('an absent or all-null series is null, not zero', () => {
    assert.equal(normalizeDayTotals([]).loadKwh, null);
    assert.equal(normalizeDayTotals([{ variable: 'loads', values: [null, null] }]).loadKwh, null);
  });
});

describe('normalizeHistory', () => {
  test('merges variables onto shared timestamps with the same sign rules', () => {
    const samples = normalizeHistory([
      {
        variable: 'pvPower',
        data: [
          { time: '2026-08-29 12:00:00 GMT+1', value: 3.2 },
          { time: '2026-08-29 12:05:00 GMT+1', value: 3.4 },
        ],
      },
      { variable: 'feedinPower', data: [{ time: '2026-08-29 12:00:00 GMT+1', value: 2.1 }] },
      { variable: 'gridConsumptionPower', data: [{ time: '2026-08-29 12:05:00 GMT+1', value: 0.4 }] },
      { variable: 'batDischargePower', data: [{ time: '2026-08-29 12:00:00 GMT+1', value: 1.5 }] },
      { variable: 'SoC', data: [{ time: '2026-08-29 12:00:00 GMT+1', value: 74 }] },
    ]);

    assert.equal(samples.length, 2);
    assert.equal(samples[0]!.solarKw, 3.2);
    assert.equal(samples[0]!.gridKw, -2.1, 'export must be negative, as in the live path');
    assert.equal(samples[0]!.batteryKw, -1.5, 'discharge must be negative, as in the live path');
    assert.equal(samples[0]!.soc, 74);
    assert.equal(samples[1]!.gridKw, 0.4);
  });

  test('returns samples sorted by time', () => {
    const samples = normalizeHistory([
      {
        variable: 'pvPower',
        data: [
          { time: '2026-08-29 12:10:00 GMT', value: 1 },
          { time: '2026-08-29 12:00:00 GMT', value: 2 },
        ],
      },
    ]);
    assert.deepEqual(samples.map((s) => s.solarKw), [2, 1]);
  });

  test('skips points with unparseable times', () => {
    const samples = normalizeHistory([
      { variable: 'pvPower', data: [{ time: 'garbage', value: 1 }, { time: '2026-08-29 12:00:00 GMT', value: 2 }] },
    ]);
    assert.equal(samples.length, 1);
  });

  test('returns nothing for an empty response', () => {
    assert.deepEqual(normalizeHistory([]), []);
  });
});
