/**
 * Typed wrappers for the endpoints this project uses.
 *
 * This is the ONLY file that names FoxESS paths. All seven are read-only, and that is a deliberate
 * boundary, not an accident of scope: the API key can change inverter settings, and the entire
 * point of the project is to look without touching. Adding any of the API's `set` paths here would
 * change what the application is. See docs/DECISIONS.md and CLAUDE.md.
 */

import type { FoxClient } from './client.ts';
import type {
  AccessCountResult,
  DeviceDetail,
  DeviceListItem,
  DeviceListResult,
  GenerationResult,
  HistoryResult,
  RealResult,
  ReportSeries,
} from './types.ts';

export const PATHS = {
  deviceList: '/op/v0/device/list',
  deviceDetail: '/op/v0/device/detail',
  realQuery: '/op/v1/device/real/query',
  historyQuery: '/op/v0/device/history/query',
  reportQuery: '/op/v0/device/report/query',
  generation: '/op/v0/device/generation',
  // The READ half of the min-SOC pair. The matching `battery/soc/set` is deliberately absent.
  batterySoc: '/op/v0/device/battery/soc/get',
  accessCount: '/op/v0/user/getAccessCount',
} as const;

/**
 * Variables requested on every live poll.
 *
 * Always pass an explicit list: omitting `variables` makes the API return every variable the
 * inverter has, which is a far larger response for no benefit.
 */
export const REAL_VARIABLES = [
  // Power flows
  'pvPower',
  'loadsPower',
  'feedinPower',
  'gridConsumptionPower',
  'generationPower',
  'epsPower',
  // Battery
  'SoC',
  'SOH',
  'ResidualEnergy',
  'batChargePower',
  'batDischargePower',
  'invBatPower',
  'batTemperature',
  // Environment / status
  'ambientTemperation', // sic — the API's own spelling
  'runningState',
] as const;

/** Energy totals for the day breakdown. Spellings are the API's own. */
export const REPORT_VARIABLES = [
  'generation',
  'PVEnergyTotal',
  'loads',
  'feedin',
  'gridConsumption',
  'chargeEnergyToTal', // sic
  'dischargeEnergyToTal', // sic
] as const;

/** Variables backfilled once at startup to reconstruct today's chart. */
export const HISTORY_VARIABLES = [
  'pvPower',
  'loadsPower',
  'feedinPower',
  'gridConsumptionPower',
  'SoC',
  'batChargePower',
  'batDischargePower',
] as const;

export type ReportDimension = 'year' | 'month' | 'day';

export function createEndpoints(client: FoxClient) {
  return {
    /** All inverters on the account. Paged, but 500 covers any realistic install. */
    async deviceList(): Promise<DeviceListItem[]> {
      const result = await client.call<DeviceListResult>({
        method: 'POST',
        path: PATHS.deviceList,
        body: { currentPage: 1, pageSize: 500 },
      });
      return result?.data ?? [];
    },

    deviceDetail(sn: string): Promise<DeviceDetail> {
      return client.call<DeviceDetail>({
        method: 'GET',
        path: PATHS.deviceDetail,
        query: { sn },
      });
    },

    /**
     * Live readings. Up to 50 serials in one call — which is also why the budget maths holds for a
     * multi-inverter site: it stays one call per poll either way.
     */
    realQuery(sns: string[], variables: readonly string[] = REAL_VARIABLES): Promise<RealResult[]> {
      return client.call<RealResult[]>({
        method: 'POST',
        path: PATHS.realQuery,
        body: { sns, variables: [...variables] },
      });
    },

    /** Time series over a window of at most 24 hours. Timestamps are epoch milliseconds. */
    historyQuery(
      sn: string,
      begin: number,
      end: number,
      variables: readonly string[] = HISTORY_VARIABLES,
    ): Promise<HistoryResult[]> {
      return client.call<HistoryResult[]>({
        method: 'POST',
        path: PATHS.historyQuery,
        body: { sn, variables: [...variables], begin, end },
      });
    },

    /**
     * Energy totals. For `dimension: 'day'`, each series holds one value per hour of that day;
     * sum them for the day's total.
     */
    reportQuery(input: {
      sn: string;
      year: number;
      month?: number;
      day?: number;
      dimension: ReportDimension;
      variables?: readonly string[];
    }): Promise<ReportSeries[]> {
      const { sn, year, month, day, dimension, variables = REPORT_VARIABLES } = input;
      return client.call<ReportSeries[]>({
        method: 'POST',
        path: PATHS.reportQuery,
        body: {
          sn,
          year,
          ...(month === undefined ? {} : { month }),
          ...(day === undefined ? {} : { day }),
          dimension,
          variables: [...variables],
        },
      });
    },

    /**
     * The battery's minimum-SOC settings, as integer percentages.
     *
     * `minSocOnGrid` is the floor while grid-connected (reserve kept for a power cut);
     * `minSoc` is the lower floor that applies once running off-grid.
     */
    batterySoc(sn: string): Promise<{ minSoc?: number; minSocOnGrid?: number }> {
      return client.call<{ minSoc?: number; minSocOnGrid?: number }>({
        method: 'GET',
        path: PATHS.batterySoc,
        query: { sn },
      });
    },

    /** today / month / cumulative generation in kWh — three headline figures for one call. */
    generation(sn: string): Promise<GenerationResult> {
      return client.call<GenerationResult>({
        method: 'GET',
        path: PATHS.generation,
        query: { sn },
      });
    },

    /** The authoritative quota figures. Both fields arrive as strings. */
    async accessCount(): Promise<{ total: number; remaining: number }> {
      const result = await client.call<AccessCountResult>({
        method: 'GET',
        path: PATHS.accessCount,
      });
      return { total: Number(result.total), remaining: Number(result.remaining) };
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
