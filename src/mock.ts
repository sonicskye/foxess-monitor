/**
 * Synthetic data for `FOXESS_MOCK=1`.
 *
 * The API allows 1440 calls a day. Iterating on a dashboard costs far more page loads than that, so
 * building the UI against the real API would either exhaust the quota or make development
 * artificially slow. Mock mode stands in for the whole `Endpoints` surface and makes zero network
 * calls, so all frontend work happens here.
 *
 * The generated day is deliberately *plausible* rather than tidy: a solar bell curve, a household
 * load with morning and evening peaks, a battery that charges on surplus and discharges after dark,
 * and grid flow as the remainder. That exercises the parts of the UI that only appear in real data
 * — export in the afternoon, import at breakfast, the battery crossing zero, a low overnight SOC.
 */

import type { Endpoints } from './foxess/endpoints.ts';
import { startOfLocalDay } from './localdate.ts';
import type { DeviceListItem, RealResult } from './foxess/types.ts';

export const MOCK_SN = 'MOCK1234567890';

const BATTERY_CAPACITY_KWH = 10.4;
const PEAK_SOLAR_KW = 4.2;

/** Deterministic jitter — a plausible wobble that is stable for a given input. */
function wobble(seed: number, amount: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amount;
}

/** Solar follows a bell curve centred on ~13:00, zero before 06:00 and after 20:00. */
function solarAt(hour: number, dayIndex: number): number {
  if (hour < 6 || hour > 20) return 0;
  const t = (hour - 13) / 3.4;
  const clear = PEAK_SOLAR_KW * Math.exp(-0.5 * t * t);
  // A slow cloud factor, so the curve is not a perfect parabola.
  const cloud = 0.78 + 0.22 * Math.sin(hour * 1.7 + dayIndex);
  return Math.max(0, clear * cloud + wobble(hour * 60 + dayIndex, 0.12));
}

/** Household load: a low baseline with breakfast and evening peaks. */
function loadAt(hour: number, dayIndex: number): number {
  const base = 0.35;
  const morning = 1.5 * Math.exp(-0.5 * ((hour - 7.5) / 1.1) ** 2);
  const evening = 2.3 * Math.exp(-0.5 * ((hour - 18.5) / 1.6) ** 2);
  return Math.max(0.15, base + morning + evening + wobble(hour * 97 + dayIndex, 0.15));
}

export interface MockReading {
  solarKw: number;
  loadKw: number;
  batteryKw: number;
  gridKw: number;
  soc: number;
}

/**
 * Simulate the day up to `at`, returning the state at that moment.
 *
 * SOC is integrated forward from a 22% overnight low so the battery behaves consistently: surplus
 * charges it until full, deficit discharges it until it hits the 10% reserve, and only then does
 * the grid make up the difference.
 */
export function simulate(at: number, timeZone: string): MockReading {
  const dayStart = startOfLocalDay(new Date(at), timeZone);
  const dayIndex = Math.floor(dayStart / 86_400_000);
  const stepMinutes = 5;
  const elapsedMinutes = Math.max(0, (at - dayStart) / 60_000);

  let soc = 22;
  let reading: MockReading = { solarKw: 0, loadKw: 0, batteryKw: 0, gridKw: 0, soc };

  for (let minute = 0; minute <= elapsedMinutes; minute += stepMinutes) {
    const hour = minute / 60;
    const solarKw = solarAt(hour, dayIndex);
    const loadKw = loadAt(hour, dayIndex);
    const surplus = solarKw - loadKw;

    let batteryKw = 0;
    if (surplus > 0) {
      const headroom = ((100 - soc) / 100) * BATTERY_CAPACITY_KWH;
      batteryKw = Math.min(surplus, 3.0, headroom * 4); // charge, capped by rate and headroom
    } else {
      const available = ((soc - 10) / 100) * BATTERY_CAPACITY_KWH; // 10% reserve
      batteryKw = -Math.min(-surplus, 3.0, Math.max(0, available) * 4);
    }

    // Grid takes whatever is left over. Positive = importing, as everywhere else.
    const gridKw = loadKw + batteryKw - solarKw;
    soc = Math.max(0, Math.min(100, soc + ((batteryKw * (stepMinutes / 60)) / BATTERY_CAPACITY_KWH) * 100));

    reading = {
      solarKw: Number(solarKw.toFixed(3)),
      loadKw: Number(loadKw.toFixed(3)),
      batteryKw: Number(batteryKw.toFixed(3)),
      gridKw: Number(gridKw.toFixed(3)),
      soc: Number(soc.toFixed(1)),
    };
  }

  return reading;
}

/** Format an instant the way an inverter does: `yyyy-MM-dd HH:mm:ss GMT+N`. */
function inverterTime(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(at));

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const offset = get('timeZoneName').replace('GMT', '').replace(/:00$/, '') || '+0';
  const hour = get('hour') === '24' ? '00' : get('hour');

  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')} GMT${offset}`;
}

/** Build a `real/query` response equivalent to what a real inverter would send. */
export function mockRealResult(at: number, timeZone: string): RealResult {
  const r = simulate(at, timeZone);
  const time = inverterTime(at, timeZone);

  const datas = [
    { variable: 'pvPower', unit: 'kW', value: r.solarKw },
    { variable: 'loadsPower', unit: 'kW', value: r.loadKw },
    // Split back into the API's two positive series, so normalize.ts gets exercised for real.
    { variable: 'gridConsumptionPower', unit: 'kW', value: Math.max(0, r.gridKw) },
    { variable: 'feedinPower', unit: 'kW', value: Math.max(0, -r.gridKw) },
    { variable: 'batChargePower', unit: 'kW', value: Math.max(0, r.batteryKw) },
    { variable: 'batDischargePower', unit: 'kW', value: Math.max(0, -r.batteryKw) },
    { variable: 'invBatPower', unit: 'kW', value: -r.batteryKw }, // positive on discharge, as the API does
    // The inverter's AC output is what leaves it on the AC side: the house load plus anything
    // exported. (It is NOT solar minus charging — that ignores imports and battery discharge.)
    {
      variable: 'generationPower',
      unit: 'kW',
      value: Number((r.loadKw + Math.max(0, -r.gridKw)).toFixed(3)),
    },
    { variable: 'epsPower', unit: 'kW', value: 0 },
    { variable: 'SoC', unit: '%', value: r.soc },
    { variable: 'SOH', unit: '%', value: 99 },
    { variable: 'ResidualEnergy', unit: 'kWh', value: Number(((r.soc / 100) * BATTERY_CAPACITY_KWH).toFixed(2)) },
    { variable: 'batTemperature', unit: '℃', value: Number((17 + wobble(at / 3.6e6, 1.5)).toFixed(1)) },
    { variable: 'ambientTemperation', unit: '℃', value: Number((19 + wobble(at / 3.6e6 + 7, 3)).toFixed(1)) },
    // 163 = on-grid. The codes are 160–170; there is no state 1 (see docs/API-NOTES.md).
    { variable: 'runningState', value: 163 },
  ];

  return { deviceSN: MOCK_SN, datas: datas.map((d) => ({ ...d, time })) };
}

const DEVICE: DeviceListItem = {
  deviceSN: MOCK_SN,
  moduleSN: 'MOCKMODULE01',
  stationName: 'Mock House',
  productType: 'H1',
  deviceType: 'H1-5.0-E',
  hasBattery: true,
  hasPV: true,
  status: 1,
};

/**
 * A stand-in for `Endpoints` that never touches the network.
 *
 * Same shape as the real thing, so the poller and server are exercised exactly as in production —
 * only the data source changes.
 */
export function createMockEndpoints(opts: { timeZone: string; now?: () => number }): Endpoints {
  const now = opts.now ?? (() => Date.now());
  const { timeZone } = opts;

  /** Hourly energy figures for today, integrated from the same simulation. */
  function hourly(pick: (r: MockReading) => number, hoursElapsed: number): number[] {
    const dayStart = startOfLocalDay(new Date(now()), timeZone);
    const values: number[] = [];
    for (let hour = 0; hour <= hoursElapsed; hour++) {
      let total = 0;
      for (let minute = 0; minute < 60; minute += 15) {
        total += Math.max(0, pick(simulate(dayStart + (hour * 60 + minute) * 60_000, timeZone))) * 0.25;
      }
      values.push(Number(total.toFixed(3)));
    }
    return values;
  }

  return {
    async deviceList() {
      return [DEVICE];
    },

    async deviceDetail(sn: string) {
      return { ...DEVICE, deviceSN: sn, batteryList: [{ batterySN: 'MOCKBAT01', model: 'HV2600' }] };
    },

    async realQuery(sns: string[]) {
      return sns.map((sn) => ({ ...mockRealResult(now(), timeZone), deviceSN: sn }));
    },

    async historyQuery(_sn: string, begin: number, end: number) {
      const points: { time: string; value: number }[][] = [[], [], [], [], [], [], []];
      // 5-minute resolution, matching what the real API returns for a day window.
      for (let t = begin; t <= end; t += 5 * 60_000) {
        const r = simulate(t, timeZone);
        const time = inverterTime(t, timeZone);
        points[0]!.push({ time, value: r.solarKw });
        points[1]!.push({ time, value: r.loadKw });
        points[2]!.push({ time, value: Math.max(0, -r.gridKw) });
        points[3]!.push({ time, value: Math.max(0, r.gridKw) });
        points[4]!.push({ time, value: r.soc });
        points[5]!.push({ time, value: Math.max(0, r.batteryKw) });
        points[6]!.push({ time, value: Math.max(0, -r.batteryKw) });
      }

      return [
        {
          deviceSN: MOCK_SN,
          datas: [
            { variable: 'pvPower', unit: 'kW', data: points[0]! },
            { variable: 'loadsPower', unit: 'kW', data: points[1]! },
            { variable: 'feedinPower', unit: 'kW', data: points[2]! },
            { variable: 'gridConsumptionPower', unit: 'kW', data: points[3]! },
            { variable: 'SoC', unit: '%', data: points[4]! },
            { variable: 'batChargePower', unit: 'kW', data: points[5]! },
            { variable: 'batDischargePower', unit: 'kW', data: points[6]! },
          ],
        },
      ];
    },

    async reportQuery() {
      const dayStart = startOfLocalDay(new Date(now()), timeZone);
      const hoursElapsed = Math.floor((now() - dayStart) / 3600_000);

      return [
        { variable: 'PVEnergyTotal', unit: 'kWh', values: hourly((r) => r.solarKw, hoursElapsed) },
        { variable: 'generation', unit: 'kWh', values: hourly((r) => r.solarKw * 0.96, hoursElapsed) },
        { variable: 'loads', unit: 'kWh', values: hourly((r) => r.loadKw, hoursElapsed) },
        { variable: 'gridConsumption', unit: 'kWh', values: hourly((r) => r.gridKw, hoursElapsed) },
        { variable: 'feedin', unit: 'kWh', values: hourly((r) => -r.gridKw, hoursElapsed) },
        { variable: 'chargeEnergyToTal', unit: 'kWh', values: hourly((r) => r.batteryKw, hoursElapsed) },
        { variable: 'dischargeEnergyToTal', unit: 'kWh', values: hourly((r) => -r.batteryKw, hoursElapsed) },
      ];
    },

    async generation() {
      const dayStart = startOfLocalDay(new Date(now()), timeZone);
      const hoursElapsed = Math.floor((now() - dayStart) / 3600_000);
      const today = hourly((r) => r.solarKw, hoursElapsed).reduce((a, b) => a + b, 0);

      return {
        today: Number(today.toFixed(1)),
        month: Number((today + 312.4).toFixed(1)),
        cumulative: Number((today + 8451.9).toFixed(1)),
      };
    },

    async accessCount() {
      // Mock mode spends no quota, and the UI should show that honestly.
      return { total: 1440, remaining: 1440 };
    },
  };
}
