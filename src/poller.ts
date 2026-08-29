/**
 * The polling scheduler.
 *
 * Owns every API call the process makes. Browsers read the cache this maintains and never trigger a
 * fetch, so quota consumption is a constant independent of how many people are watching or how
 * often the kiosk reloads.
 *
 * Jobs are scheduled individually rather than on one shared tick, because they have very different
 * periods (90 s vs 10 min vs 1 h) and a shared tick would either over-poll the slow ones or
 * under-poll the fast one.
 */

import type { AuditLog } from './audit.ts';
import type { Budget } from './budget.ts';
import type { Config } from './config.ts';
import type { Endpoints } from './foxess/endpoints.ts';
import { BudgetDeniedError } from './foxess/types.ts';
import { createTransitionLogger, type Logger } from './log.ts';
import { startOfLocalDay } from './localdate.ts';
import {
  batteryEnergy,
  deriveCapacityKwh,
  normalizeDayTotals,
  normalizeHistory,
  normalizeSnapshot,
  parseNameplateCapacityKwh,
  toSample,
  type BatteryEnergy,
  type DayTotals,
  type Snapshot,
} from './normalize.ts';
import type { SampleStore } from './store.ts';

export interface GenerationTotals {
  todayKwh: number | null;
  monthKwh: number | null;
  cumulativeKwh: number | null;
}

export interface DeviceInfo {
  sn: string;
  stationName: string | null;
  productType: string | null;
  deviceType: string | null;
  hasBattery: boolean;
}

export interface JobHealth {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  runs: number;
  failures: number;
}

export interface PollerState {
  devices: DeviceInfo[];
  snapshots: Record<string, Snapshot>;
  totals: DayTotals | null;
  generation: GenerationTotals | null;
  /** Stored vs usable vs reserved for the primary device. */
  battery: BatteryEnergy;
  jobs: Record<string, JobHealth>;
  /** True while no browser has been connected for longer than IDLE_SLOWDOWN_SECONDS. */
  idle: boolean;
  startedAt: string;
}

export interface Poller {
  start(): Promise<void>;
  stop(): void;
  state(): PollerState;
  /** Latest snapshot for the primary (first) device. */
  primary(): Snapshot | null;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  /** Tell the poller a browser is connected, so it leaves idle mode. */
  noteViewerActivity(): void;
}

export interface PollerOptions {
  config: Config;
  api: Endpoints;
  budget: Budget;
  audit: AuditLog;
  store: SampleStore;
  log: Logger;
  now?: () => number;
}

export function createPoller(opts: PollerOptions): Poller {
  const { config, api, budget, audit, store, log } = opts;
  const now = opts.now ?? (() => Date.now());

  let devices: DeviceInfo[] = [];
  const snapshots: Record<string, Snapshot> = {};
  let totals: DayTotals | null = null;
  let generation: GenerationTotals | null = null;
  /** Min-SOC floors, from the slow settings poll. */
  let minSoc: number | null = null;
  let minSocOnGrid: number | null = null;
  /**
   * Best pack-size estimate, kWh. Seeded from the device-detail nameplate, then superseded by a
   * telemetry-derived figure and smoothed, since SOC arrives as an integer percent.
   */
  let capacityKwh: number | null = null;
  let capacityFromTelemetry = false;
  let idle = false;
  let lastViewerAt = now();
  const startedAt = new Date(now()).toISOString();

  const jobs: Record<string, JobHealth> = {};
  const timers = new Set<NodeJS.Timeout>();
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let stopped = false;

  /** One line when the inverter goes stale, one when it recovers — never one per poll. */
  const trackStale = createTransitionLogger<boolean>(log, (from, to) => {
    if (from === undefined && !to) return null; // healthy at startup is not news
    return to
      ? { level: 'warn', msg: 'inverter data has gone stale — display will show it as not live' }
      : { level: 'info', msg: 'inverter data is live again' };
  });

  const trackIdle = createTransitionLogger<boolean>(log, (from, to) => {
    if (from === undefined) return null;
    return to
      ? { level: 'info', msg: 'no viewers — slowing the poll to save quota', fields: { everySeconds: config.poll.idlePollSeconds } }
      : { level: 'info', msg: 'viewer connected — resuming the normal poll', fields: { everySeconds: config.poll.realSeconds } };
  });

  function health(name: string): JobHealth {
    return (jobs[name] ??= {
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      nextRunAt: null,
      runs: 0,
      failures: 0,
    });
  }

  function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Run a job, recording health and swallowing the error.
   *
   * A failing job must never stop the schedule: a transient API blip should cost one poll, not the
   * rest of the day's updates.
   */
  async function run(name: string, task: () => Promise<void>): Promise<void> {
    const state = health(name);
    state.lastRunAt = new Date(now()).toISOString();
    state.runs += 1;

    try {
      await task();
      state.lastSuccessAt = new Date(now()).toISOString();
      state.lastError = null;
    } catch (err) {
      state.failures += 1;
      state.lastError = describe(err);

      if (err instanceof BudgetDeniedError) {
        // Expected back-pressure, not a fault. The budget logs the interesting part itself.
        log.debug('job skipped by the budget', { job: name, reason: err.reason });
      } else {
        log.warn('job failed', { job: name, err });
      }
    }
  }

  /** Schedule `task` on a self-rescheduling timer, so a slow run cannot overlap the next. */
  function schedule(name: string, intervalSeconds: () => number, task: () => Promise<void>): void {
    const tick = async (): Promise<void> => {
      if (stopped) return;
      await run(name, task);
      if (stopped) return;

      const delay = intervalSeconds() * 1000;
      health(name).nextRunAt = new Date(now() + delay).toISOString();
      const timer = setTimeout(tick, delay);
      timer.unref?.();
      timers.add(timer);
    };
    void tick();
  }

  async function discoverDevices(): Promise<void> {
    if (config.deviceSNs.length > 0) {
      // Trust the explicit configuration, but still fetch detail for the header.
      devices = config.deviceSNs.map((sn) => ({
        sn,
        stationName: null,
        productType: null,
        deviceType: null,
        hasBattery: true,
      }));
    }

    const listed = await api.deviceList();
    const wanted = config.deviceSNs.length > 0 ? new Set(config.deviceSNs) : null;

    const found = listed
      .filter((d) => (wanted ? wanted.has(d.deviceSN) : true))
      .map((d) => ({
        sn: d.deviceSN,
        stationName: d.stationName ?? null,
        productType: d.productType ?? null,
        deviceType: d.deviceType ?? null,
        hasBattery: d.hasBattery ?? true,
      }));

    if (found.length === 0) {
      log.error('no inverters found', {
        configured: config.deviceSNs,
        available: listed.map((d) => d.deviceSN),
      });
      return;
    }

    devices = found;

    // The nameplate seeds the capacity estimate so the first render has something, before SOC has
    // been high enough for the telemetry-derived figure.
    try {
      const detail = await api.deviceDetail(found[0]!.sn);
      const nameplate = parseNameplateCapacityKwh(detail.batteryList);
      if (nameplate !== null && !capacityFromTelemetry) {
        capacityKwh = nameplate;
        log.info('battery capacity from nameplate', { capacityKwh: nameplate });
      }
      const station = detail.stationName ?? found[0]!.stationName;
      if (station) devices = devices.map((d, i) => (i === 0 ? { ...d, stationName: station } : d));
    } catch (err) {
      // Non-fatal: the estimate will arrive from telemetry instead.
      log.debug('could not read device detail', { err });
    }

    log.info('discovered inverters', {
      count: devices.length,
      sns: devices.map((d) => d.sn),
      station: devices[0]!.stationName,
    });
  }

  async function pollReal(): Promise<void> {
    if (devices.length === 0) return;

    // One call covers up to 50 serials, so a multi-inverter site costs the same as a single one.
    const results = await api.realQuery(devices.map((d) => d.sn));

    for (const result of results) {
      const snapshot = normalizeSnapshot(result, { now: now() });
      snapshots[snapshot.deviceSN] = snapshot;

      // Only record samples we believe: a stale reading repeated for hours would draw a flat line
      // that never happened.
      if (!snapshot.stale) store.append(toSample(snapshot));

      for (const listener of listeners) {
        try {
          listener(snapshot);
        } catch (err) {
          log.warn('snapshot listener threw', { err });
        }
      }
    }

    const primarySnapshot = snapshots[devices[0]!.sn];
    if (primarySnapshot) {
      trackStale(primarySnapshot.stale);
      updateCapacity(primarySnapshot);
    }
  }

  /**
   * Refine the pack-size estimate from a live reading.
   *
   * `deriveCapacityKwh` declines below 20% SOC, where integer-percent quantisation makes the
   * division unreliable — so overnight the previous estimate simply persists. An exponential moving
   * average damps the remaining jitter; the first telemetry value replaces the nameplate outright
   * rather than being averaged with it, since the two are not measuring quite the same thing.
   */
  function updateCapacity(snapshot: Snapshot): void {
    const derived = deriveCapacityKwh(snapshot.soc, snapshot.residualKwh);
    if (derived === null) return;

    if (!capacityFromTelemetry || capacityKwh === null) {
      capacityKwh = derived;
      capacityFromTelemetry = true;
      log.info('battery capacity estimated from telemetry', { capacityKwh: Number(derived.toFixed(2)) });
      return;
    }
    capacityKwh = capacityKwh * 0.8 + derived * 0.2;
  }

  async function pollSettings(): Promise<void> {
    const device = devices[0];
    // A grid-tied inverter has no battery settings; asking every 6 hours forever would just log
    // an error every 6 hours forever.
    if (!device || !device.hasBattery) return;

    const result = await api.batterySoc(device.sn);
    const next = {
      minSoc: typeof result.minSoc === 'number' ? result.minSoc : null,
      minSocOnGrid: typeof result.minSocOnGrid === 'number' ? result.minSocOnGrid : null,
    };

    if (next.minSoc !== minSoc || next.minSocOnGrid !== minSocOnGrid) {
      log.info('battery minimum SOC', next);
    }
    minSoc = next.minSoc;
    minSocOnGrid = next.minSocOnGrid;
  }

  async function pollTotals(): Promise<void> {
    const device = devices[0];
    if (!device) return;

    const at = new Date(now());
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');

    const report = await api.reportQuery({
      sn: device.sn,
      year: get('year'),
      month: get('month'),
      day: get('day'),
      dimension: 'day',
    });
    totals = normalizeDayTotals(report);
  }

  async function pollGeneration(): Promise<void> {
    const device = devices[0];
    if (!device) return;

    const result = await api.generation(device.sn);
    generation = {
      todayKwh: result.today ?? null,
      monthKwh: result.month ?? null,
      cumulativeKwh: result.cumulative ?? null,
    };
  }

  async function pollQuota(): Promise<void> {
    const counts = await api.accessCount();
    budget.reconcile(counts);

    if (counts.remaining < 100) {
      log.warn('running low on API quota', { ...counts, localUsed: budget.state().used });
    }
  }

  /**
   * One history call at startup, to reconstruct today's chart from local midnight.
   *
   * Without this a restart leaves the graph starting at whenever the process came up, which on a
   * machine that reboots is most of the time.
   */
  async function backfillToday(): Promise<void> {
    const device = devices[0];
    if (!device) return;

    const at = now();
    const begin = startOfLocalDay(new Date(at), config.timeZone);
    const existing = store.readDay(new Date(at));

    // Nothing to gain if the file already covers the day at poll resolution.
    const expected = Math.floor((at - begin) / (config.poll.realSeconds * 1000));
    if (existing.length >= expected * 0.9 && existing.length > 0) {
      log.info('skipping backfill — today is already covered', { samples: existing.length });
      return;
    }

    const history = await api.historyQuery(device.sn, begin, at);
    const samples = normalizeHistory(history[0]?.datas ?? []);
    const added = store.backfill(samples, new Date(at));

    log.info('backfilled today from history', { fetched: samples.length, added });
  }

  return {
    async start() {
      log.info('starting poller', {
        mock: config.mock,
        timeZone: config.timeZone,
        realSeconds: config.poll.realSeconds,
        totalsSeconds: config.poll.totalsSeconds,
        cap: config.dailyCallBudget,
      });

      // Sequential and awaited: discovery must land before anything that needs a serial, and the
      // per-path gate spaces these out anyway.
      await run('discover', discoverDevices);
      if (devices.length === 0) {
        log.error('no inverters to poll — check FOXESS_DEVICE_SN and the account');
        return;
      }

      await run('backfill', backfillToday);
      await run('quota', pollQuota);

      store.prune(new Date(now()));
      audit.prune(new Date(now()));

      schedule(
        'real',
        () => {
          // Idle only matters between polls, so evaluate it here rather than on a separate timer.
          const quiet = config.poll.idleSlowdownSeconds > 0 &&
            now() - lastViewerAt > config.poll.idleSlowdownSeconds * 1000;
          if (quiet !== idle) {
            idle = quiet;
            trackIdle(quiet);
          }
          return idle ? config.poll.idlePollSeconds : config.poll.realSeconds;
        },
        pollReal,
      );

      schedule('settings', () => config.poll.settingsSeconds, pollSettings);
      schedule('totals', () => config.poll.totalsSeconds, pollTotals);
      schedule('generation', () => config.poll.totalsSeconds, pollGeneration);
      schedule('quota', () => config.poll.quotaSeconds, async () => {
        await pollQuota();
        // Cheap, and it keeps the day-files from growing without bound.
        store.prune(new Date(now()));
        audit.prune(new Date(now()));
      });
    },

    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },

    state() {
      const primary = devices[0] ? (snapshots[devices[0].sn] ?? null) : null;
      return {
        devices,
        snapshots,
        totals,
        generation,
        battery: batteryEnergy({
          soc: primary?.soc ?? null,
          residualKwh: primary?.residualKwh ?? null,
          capacityKwh,
          minSoc,
          minSocOnGrid,
          runningState: primary?.runningState ?? null,
        }),
        jobs,
        idle,
        startedAt,
      };
    },

    primary() {
      const device = devices[0];
      return device ? (snapshots[device.sn] ?? null) : null;
    },

    onSnapshot(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    noteViewerActivity() {
      lastViewerAt = now();
      if (idle) {
        idle = false;
        trackIdle(false);
      }
    },
  };
}
