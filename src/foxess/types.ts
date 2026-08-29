/**
 * FoxESS OpenAPI response shapes.
 *
 * Field names and spellings mirror the API exactly, including its own inconsistencies
 * (`ambientTemperation`, `chargeEnergyToTal`). Do not "fix" them here — they are wire format.
 * See docs/API-NOTES.md.
 */

/** Every response is this envelope. `errno` is in the BODY, not the HTTP status. */
export interface FoxEnvelope<T> {
  errno: number;
  msg?: string;
  result: T;
}

/** One variable reading from `/op/v1/device/real/query`. */
export interface RealDatum {
  variable: string;
  unit?: string;
  name?: string;
  value: number | string;
  /** Inverter local time, `yyyy-MM-dd HH:mm:ss zZ`. Present on at least one datum in practice. */
  time?: string;
}

export interface RealResult {
  deviceSN: string;
  /** Variables the inverter had no value for are simply absent. */
  datas: RealDatum[];
}

export interface DeviceListItem {
  deviceSN: string;
  moduleSN?: string;
  stationID?: string;
  stationName?: string;
  productType?: string;
  deviceType?: string;
  hasBattery?: boolean;
  hasPV?: boolean;
  /** 1 online, 2 alarm, 3 offline (per the device list docs). */
  status?: number;
}

export interface DeviceListResult {
  currentPage?: number;
  pageSize?: number;
  total?: number;
  data: DeviceListItem[];
}

export interface DeviceDetail {
  deviceSN: string;
  moduleSN?: string;
  stationID?: string;
  stationName?: string;
  productType?: string;
  deviceType?: string;
  hasBattery?: boolean;
  hasPV?: boolean;
  status?: number;
  /** Inverter rated power in **kW** — NOT battery energy. See docs/API-NOTES.md. */
  capacity?: number;
  batteryList?: {
    batterySN?: string;
    type?: string;
    model?: string;
    version?: string;
    /** sic — the API misspells "capacity". Units undocumented; see `parseNameplateCapacityKwh`. */
    capicty?: string | number;
  }[];
}

/** `/op/v0/device/generation` — kWh. */
export interface GenerationResult {
  today?: number;
  month?: number;
  cumulative?: number;
}

/** One variable's series from `/op/v0/device/report/query`. For `dimension: 'day'`, one per hour. */
export interface ReportSeries {
  variable: string;
  unit?: string;
  values: (number | null)[];
}

/** One variable's series from `/op/v0/device/history/query`. */
export interface HistorySeries {
  variable: string;
  unit?: string;
  name?: string;
  data: { time: string; value: number }[];
}

export interface HistoryResult {
  deviceSN: string;
  datas: HistorySeries[];
}

/** `/op/v0/user/getAccessCount` — note both fields arrive as STRINGS. */
export interface AccessCountResult {
  total: string | number;
  remaining: string | number;
}

/** Documented error numbers we handle specifically. */
export const ERRNO = {
  OK: 0,
  BAD_HEADERS: 40256,
  BAD_BODY: 40257,
  RATE_LIMITED: 40400,
} as const;

const ERRNO_MEANING: Record<number, string> = {
  [ERRNO.BAD_HEADERS]:
    'request header parameters missing or invalid — almost always a bad signature. ' +
    'Check that the \\r\\n separator is LITERAL, not CRLF, and that only the path is signed ' +
    '(see docs/DECISIONS.md §1)',
  [ERRNO.BAD_BODY]: 'request body parameters invalid — check the payload against docs/API-NOTES.md',
  [ERRNO.RATE_LIMITED]:
    'too many requests — the daily quota (1440/inverter) is likely spent, or calls came faster ' +
    'than 1/sec for this interface',
};

export function describeErrno(errno: number): string {
  return ERRNO_MEANING[errno] ?? `unrecognised FoxESS error number ${errno}`;
}

/** A FoxESS call that returned a non-zero `errno`. */
export class FoxApiError extends Error {
  readonly errno: number;
  readonly path: string;
  readonly apiMessage: string | undefined;

  constructor(path: string, errno: number, apiMessage?: string) {
    super(`FoxESS ${path} failed: errno ${errno} — ${apiMessage ?? describeErrno(errno)}`);
    this.name = 'FoxApiError';
    this.errno = errno;
    this.path = path;
    this.apiMessage = apiMessage;
  }

  get isRateLimit(): boolean {
    return this.errno === ERRNO.RATE_LIMITED;
  }

  /** A bad signature will fail identically forever — retrying wastes quota. */
  get isRetryable(): boolean {
    return this.errno !== ERRNO.BAD_HEADERS && this.errno !== ERRNO.BAD_BODY;
  }
}

/** The budget refused the call. Not an API failure — nothing was sent. */
export class BudgetDeniedError extends Error {
  readonly reason: 'daily-cap' | 'backoff';
  readonly retryAfterMs: number | undefined;

  constructor(path: string, reason: 'daily-cap' | 'backoff', detail: string, retryAfterMs?: number) {
    super(`Skipped ${path}: ${detail}`);
    this.name = 'BudgetDeniedError';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}
