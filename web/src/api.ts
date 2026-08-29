/**
 * Talking to our own backend.
 *
 * SSE is the primary channel: one connection, pushed on every successful poll, near-zero CPU on the
 * kiosk. Polling is only the fallback for when the stream drops — and even then it hits our cache,
 * never FoxESS.
 */

export interface Snapshot {
  ts: string;
  deviceSN: string;
  solarKw: number | null;
  loadKw: number | null;
  /** Positive importing, negative exporting. */
  gridKw: number | null;
  /** Positive charging, negative discharging. */
  batteryKw: number | null;
  generationKw: number | null;
  epsKw: number | null;
  soc: number | null;
  soh: number | null;
  residualKwh: number | null;
  batteryTempC: number | null;
  ambientTempC: number | null;
  runningState: number | null;
  inverterTime: string | null;
  inverterTimeMs: number | null;
  stale: boolean;
}

export interface DayTotals {
  solarKwh: number | null;
  loadKwh: number | null;
  importKwh: number | null;
  exportKwh: number | null;
  batteryChargedKwh: number | null;
  batteryDischargedKwh: number | null;
  generationKwh: number | null;
}

export interface DeviceInfo {
  sn: string;
  stationName: string | null;
  productType: string | null;
  deviceType: string | null;
  hasBattery: boolean;
}

export interface SnapshotPayload {
  devices: DeviceInfo[];
  primarySN: string | null;
  snapshots: Record<string, Snapshot>;
  snapshot: Snapshot | null;
  totals: DayTotals | null;
  generation: { todayKwh: number | null; monthKwh: number | null; cumulativeKwh: number | null } | null;
  quota: {
    used: number;
    cap: number;
    remaining: number;
    reportedTotal: number | null;
    reportedRemaining: number | null;
  };
  poller: { idle: boolean; startedAt: string; pollSeconds: number };
  server: { timeZone: string; mock: boolean };
}

export interface Series {
  t: number[];
  solarKw: (number | null)[];
  loadKw: (number | null)[];
  gridKw: (number | null)[];
  batteryKw: (number | null)[];
  soc: (number | null)[];
}

export interface SeriesPayload {
  range: string;
  timeZone: string;
  series: Series;
  sampleCount: number;
}

export interface Diagnostics {
  budget: {
    day: string;
    used: number;
    cap: number;
    remaining: number;
    quotaRemaining: number | null;
    quotaTotal: number | null;
    backoffUntil: number | null;
    consecutiveRateLimits: number;
  };
  jobs: Record<
    string,
    {
      lastRunAt: string | null;
      lastSuccessAt: string | null;
      lastError: string | null;
      nextRunAt: string | null;
      runs: number;
      failures: number;
    }
  >;
  idle: boolean;
  startedAt: string;
  uptimeSeconds: number;
  config: Record<string, unknown>;
  projection: { total: number; cap: number; jobs: { name: string; callsPerDay: number }[] };
  recentCalls: {
    ts: string;
    path: string;
    ms: number;
    status: number;
    errno: number | null;
    attempt: number;
    error?: string;
  }[];
}

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return (await res.json()) as T;
}

export const fetchSnapshot = (): Promise<SnapshotPayload> => fetchJson<SnapshotPayload>('/api/snapshot');
export const fetchSeries = (points = 240): Promise<SeriesPayload> =>
  fetchJson<SeriesPayload>(`/api/series?points=${points}`);
export const fetchDiagnostics = (): Promise<Diagnostics> => fetchJson<Diagnostics>('/api/diagnostics');

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

/**
 * Subscribe to server-pushed snapshots.
 *
 * EventSource reconnects on its own, but it does so silently, so `onState` surfaces the difference
 * between "connected" and "trying" — on a wall display, silently showing stale numbers is the
 * failure to avoid.
 */
export function subscribe(handlers: {
  onSnapshot: (payload: SnapshotPayload) => void;
  onState: (state: ConnectionState) => void;
}): () => void {
  let source: EventSource | null = null;
  let pollTimer: number | undefined;
  let closed = false;

  const startFallbackPolling = (): void => {
    if (pollTimer !== undefined) return;
    // Our own cache, so this costs no FoxESS quota — only used while SSE is down.
    pollTimer = window.setInterval(() => {
      void fetchSnapshot().then(handlers.onSnapshot).catch(() => undefined);
    }, 30_000);
  };

  const stopFallbackPolling = (): void => {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const connect = (): void => {
    if (closed) return;
    handlers.onState(source === null ? 'connecting' : 'reconnecting');

    source = new EventSource('/api/stream');

    source.addEventListener('snapshot', (event) => {
      try {
        handlers.onSnapshot(JSON.parse((event as MessageEvent).data) as SnapshotPayload);
        handlers.onState('live');
        stopFallbackPolling();
      } catch {
        /* a malformed frame should not kill the stream */
      }
    });

    source.addEventListener('error', () => {
      handlers.onState('reconnecting');
      // EventSource retries by itself; polling covers the gap until it succeeds.
      startFallbackPolling();
    });
  };

  connect();

  return () => {
    closed = true;
    stopFallbackPolling();
    source?.close();
  };
}
