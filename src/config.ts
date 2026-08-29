/**
 * Environment parsing and validation.
 *
 * The important job here is the **budget pre-flight**: FoxESS allows 1440 API calls per day per
 * inverter, and the polling schedule is defined by intervals rather than by a call count. It is
 * therefore entirely possible to configure a schedule that quietly exhausts the day's quota by
 * lunchtime and leaves the display frozen until midnight. So we do the arithmetic at startup and
 * refuse to run rather than discover it at 14:00.
 */

import { statSync } from 'node:fs';
import { addSecret, createLogger, type Level } from './log.ts';

export interface PollConfig {
  realSeconds: number;
  totalsSeconds: number;
  quotaSeconds: number;
  /** Battery min-SOC settings. They change only when the owner changes them, so this is slow. */
  settingsSeconds: number;
  idleSlowdownSeconds: number;
  idlePollSeconds: number;
}

export interface Config {
  apiKey: string;
  apiBase: string;
  /** Explicit serial numbers; empty means auto-discover via /op/v0/device/list. */
  deviceSNs: string[];
  port: number;
  host: string;
  timeZone: string;
  poll: PollConfig;
  dailyCallBudget: number;
  dataDir: string;
  retainDays: number;
  logLevel: Level;
  /**
   * Battery pack size in kWh, from the installer's invoice or the FoxESS app.
   *
   * Optional, but authoritative when set — the API's `ResidualEnergy` cannot be trusted on every
   * pack (see docs/DECISIONS.md), so a known capacity plus SOC is a better source of stored energy.
   * Null means fall back to the nameplate, then to telemetry.
   */
  batteryCapacityKwh: number | null;
  mock: boolean;
  /**
   * Hours to shift the simulated clock in mock mode. Lets UI work target a specific time of day —
   * midday export, evening discharge, a low overnight SOC — instead of whatever hour it happens to
   * be. Ignored unless `mock` is set.
   */
  mockOffsetHours: number;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

function readInt(
  env: Env,
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number },
  problems: string[],
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    problems.push(`${name} must be an integer (got ${JSON.stringify(raw)})`);
    return fallback;
  }
  if (bounds.min !== undefined && value < bounds.min) {
    problems.push(`${name} must be >= ${bounds.min} (got ${value})`);
    return fallback;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    problems.push(`${name} must be <= ${bounds.max} (got ${value})`);
    return fallback;
  }
  return value;
}

/** Optional positive decimal, e.g. a battery capacity in kWh. Null when unset. */
function readOptionalFloat(
  env: Env,
  name: string,
  bounds: { min: number; max: number },
  problems: string[],
): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(`${name} must be a number (got ${JSON.stringify(raw)})`);
    return null;
  }
  if (value < bounds.min || value > bounds.max) {
    problems.push(`${name} must be between ${bounds.min} and ${bounds.max} (got ${value})`);
    return null;
  }
  return value;
}

function readBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function readLevel(env: Env, name: string, problems: string[]): Level {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return 'info';
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  problems.push(`${name} must be one of debug|info|warn|error (got ${JSON.stringify(raw)})`);
  return 'info';
}

function readTimeZone(env: Env, problems: string[]): string {
  const raw = env['TZ']?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    problems.push(`TZ is not a valid IANA timezone (got ${JSON.stringify(raw)}), e.g. Europe/London`);
    return 'UTC';
  }
}

/** Calls/day each scheduled job will make at the configured interval. */
export interface BudgetProjection {
  jobs: { name: string; intervalSeconds: number; callsPerDay: number }[];
  total: number;
  cap: number;
  withinBudget: boolean;
}

/**
 * How many calls the schedule will make in a day.
 *
 * `real/query` runs on its own interval; `generation` and `report/query` share the totals
 * interval, so a 10-minute totals interval costs 2 × 144 calls, not 144. Getting that wrong is
 * how a schedule looks affordable and isn't.
 */
export function projectDailyCalls(poll: PollConfig, cap: number): BudgetProjection {
  const perDay = (seconds: number): number => Math.ceil(86_400 / seconds);

  const jobs = [
    { name: 'device/real/query', intervalSeconds: poll.realSeconds, callsPerDay: perDay(poll.realSeconds) },
    { name: 'device/generation', intervalSeconds: poll.totalsSeconds, callsPerDay: perDay(poll.totalsSeconds) },
    { name: 'device/report/query', intervalSeconds: poll.totalsSeconds, callsPerDay: perDay(poll.totalsSeconds) },
    { name: 'user/getAccessCount', intervalSeconds: poll.quotaSeconds, callsPerDay: perDay(poll.quotaSeconds) },
    // Counted even though the poller skips it on a battery-less inverter: the validator must never
    // promise a smaller number than the schedule can actually spend.
    { name: 'battery/soc/get', intervalSeconds: poll.settingsSeconds, callsPerDay: perDay(poll.settingsSeconds) },
  ];

  const total = jobs.reduce((sum, j) => sum + j.callsPerDay, 0);
  return { jobs, total, cap, withinBudget: total <= cap };
}

/** Human-readable projection table, printed at startup and on refusal. */
export function formatProjection(p: BudgetProjection): string {
  const rows = p.jobs.map(
    (j) => `    ${j.name.padEnd(22)} every ${String(j.intervalSeconds).padStart(5)}s -> ${String(j.callsPerDay).padStart(5)}/day`,
  );
  const pct = Math.round((p.total / p.cap) * 100);
  return [
    ...rows,
    `    ${''.padEnd(22)} ${' '.repeat(11)}    ${'-'.repeat(9)}`,
    `    ${'TOTAL'.padEnd(22)} ${' '.repeat(11)}    ${String(p.total).padStart(5)}/day  (${pct}% of cap ${p.cap})`,
  ].join('\n');
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const mock = readBool(env, 'FOXESS_MOCK', false);
  const apiKey = env['FOXESS_API_KEY']?.trim() ?? '';

  if (!apiKey && !mock) {
    problems.push(
      'FOXESS_API_KEY is required. Get one from FoxESS Cloud -> User Profile -> API Management. ' +
        'Or set FOXESS_MOCK=1 to run on synthetic data with no API calls.',
    );
  }

  const apiBaseRaw = env['FOXESS_API_BASE']?.trim() || 'https://www.foxesscloud.com';
  let apiBase = apiBaseRaw;
  try {
    apiBase = new URL(apiBaseRaw).origin;
  } catch {
    problems.push(`FOXESS_API_BASE must be a valid URL (got ${JSON.stringify(apiBaseRaw)})`);
  }

  const deviceSNs = (env['FOXESS_DEVICE_SN'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (deviceSNs.length > 50) {
    problems.push(`FOXESS_DEVICE_SN lists ${deviceSNs.length} serials; the API accepts at most 50`);
  }

  const timeZone = readTimeZone(env, problems);

  const poll: PollConfig = {
    // 30s floor: below that a single inverter cannot stay inside 1440/day under any schedule,
    // and the inverter itself only reports about once a minute.
    realSeconds: readInt(env, 'POLL_REAL_SECONDS', 90, { min: 30, max: 3600 }, problems),
    totalsSeconds: readInt(env, 'POLL_TOTALS_SECONDS', 600, { min: 60, max: 86_400 }, problems),
    quotaSeconds: readInt(env, 'POLL_QUOTA_SECONDS', 3600, { min: 300, max: 86_400 }, problems),
    settingsSeconds: readInt(env, 'POLL_SETTINGS_SECONDS', 21_600, { min: 300, max: 86_400 }, problems),
    idleSlowdownSeconds: readInt(env, 'IDLE_SLOWDOWN_SECONDS', 900, { min: 0, max: 86_400 }, problems),
    idlePollSeconds: readInt(env, 'IDLE_POLL_SECONDS', 300, { min: 30, max: 86_400 }, problems),
  };

  const dailyCallBudget = readInt(env, 'DAILY_CALL_BUDGET', 1400, { min: 1, max: 1440 }, problems);

  const config: Config = {
    apiKey,
    apiBase,
    deviceSNs,
    port: readInt(env, 'PORT', 8080, { min: 1, max: 65_535 }, problems),
    host: env['HOST']?.trim() || '0.0.0.0',
    timeZone,
    poll,
    dailyCallBudget,
    dataDir: env['DATA_DIR']?.trim() || './data',
    retainDays: readInt(env, 'RETAIN_DAYS', 14, { min: 1, max: 3650 }, problems),
    logLevel: readLevel(env, 'LOG_LEVEL', problems),
    // 0.5-200 kWh spans anything from a single module to a large domestic bank.
    batteryCapacityKwh: readOptionalFloat(env, 'BATTERY_CAPACITY_KWH', { min: 0.5, max: 200 }, problems),
    mock,
    mockOffsetHours: readInt(env, 'MOCK_OFFSET_HOURS', 0, { min: -48, max: 48 }, problems),
  };

  // Only meaningful once the intervals themselves are valid.
  if (problems.length === 0) {
    const projection = projectDailyCalls(poll, dailyCallBudget);
    if (!projection.withinBudget) {
      problems.push(
        `The polling schedule would make ${projection.total} API calls/day, over the ` +
          `DAILY_CALL_BUDGET of ${dailyCallBudget}. FoxESS allows 1440/day per inverter; going over ` +
          `means the display freezes for the rest of the day.\n${formatProjection(projection)}\n` +
          `    Fix: raise POLL_REAL_SECONDS or POLL_TOTALS_SECONDS.`,
      );
    }
    if (poll.idlePollSeconds < poll.realSeconds) {
      problems.push(
        `IDLE_POLL_SECONDS (${poll.idlePollSeconds}) is shorter than POLL_REAL_SECONDS ` +
          `(${poll.realSeconds}); the idle mode is meant to slow polling down, not speed it up.`,
      );
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  // Everything logged from here on is scrubbed of the key.
  addSecret(apiKey);

  warnIfEnvFileIsReadable();

  return config;
}

/**
 * Warn when `.env` is readable by anyone but its owner.
 *
 * The runbook says `chmod 600` but nothing enforced it, and the file holds a credential that can
 * change inverter settings. A warning catches the deployment mistake without refusing to start —
 * failing hard here would be worse, since the dashboard would go down for a permissions nit.
 */
function warnIfEnvFileIsReadable(envPath = '.env'): void {
  try {
    const mode = statSync(envPath).mode & 0o077;
    if (mode !== 0) {
      createLogger('config').warn(
        'the .env file is readable by other users — it holds an API key that can change inverter settings',
        { path: envPath, mode: `0${(statSync(envPath).mode & 0o777).toString(8)}`, fix: 'chmod 600 .env' },
      );
    }
  } catch {
    // No .env at all is normal: the environment may be supplied by systemd or the shell.
  }
}
