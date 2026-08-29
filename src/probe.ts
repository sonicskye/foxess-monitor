/**
 * `npm run probe` — verify credentials against the live API for exactly 3 calls.
 *
 * Spending 3 of 1440 to find out whether the key and the signature work is the cheapest possible
 * end-to-end check, and it is the right first thing to run against a real account. It prints what
 * it found — quota, inverters, and the live variable table — so a wrong serial or a grid-tied
 * inverter with no battery shows up immediately rather than as an empty dashboard later.
 *
 * Read-only. Makes no changes to anything.
 */

import { createAuditLog } from './audit.ts';
import { createBudget } from './budget.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createClient } from './foxess/client.ts';
import { createEndpoints, REAL_VARIABLES } from './foxess/endpoints.ts';
import { FoxApiError } from './foxess/types.ts';
import { configureLogging, createLogger } from './log.ts';

const log = createLogger('probe');

function heading(text: string): void {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`);
}

function bullet(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(18)} ${value}\n`);
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\n`);
      return 2;
    }
    throw err;
  }

  configureLogging({ level: config.logLevel });

  if (config.mock) {
    process.stderr.write(
      '\nFOXESS_MOCK=1 is set, so there is nothing to probe — mock mode never contacts the API.\n' +
        'Unset it to check real credentials.\n\n',
    );
    return 2;
  }

  const budget = createBudget({
    dataDir: config.dataDir,
    timeZone: config.timeZone,
    cap: config.dailyCallBudget,
    log,
  });
  const audit = createAuditLog({
    dir: config.dataDir,
    timeZone: config.timeZone,
    retainDays: config.retainDays,
    log,
  });
  const api = createEndpoints(
    createClient({ apiBase: config.apiBase, apiKey: config.apiKey, budget, audit, log }),
  );

  process.stdout.write(`\nProbing ${config.apiBase} — this will spend 3 API calls.\n`);

  // ── 1/3 quota ───────────────────────────────────────────────────────────────
  heading('1/3  Quota  (/op/v0/user/getAccessCount)');
  const quota = await api.accessCount();
  budget.reconcile(quota);
  bullet('total', String(quota.total));
  bullet('remaining', String(quota.remaining));
  bullet('used today', String(quota.total - quota.remaining));
  if (quota.remaining < 100) {
    process.stdout.write(
      '  \x1b[33m! Very little quota left today. The dashboard will be sparse until midnight.\x1b[0m\n',
    );
  }

  // ── 2/3 devices ─────────────────────────────────────────────────────────────
  heading('2/3  Inverters  (/op/v0/device/list)');
  const devices = await api.deviceList();
  if (devices.length === 0) {
    process.stdout.write('  \x1b[31mNo inverters on this account.\x1b[0m\n');
    return 1;
  }
  for (const d of devices) {
    bullet(
      d.deviceSN,
      [d.productType, d.deviceType, d.stationName, d.hasBattery ? 'battery' : 'no battery']
        .filter(Boolean)
        .join(' · '),
    );
  }

  const configured = config.deviceSNs;
  const known = new Set(devices.map((d) => d.deviceSN));
  for (const sn of configured) {
    if (!known.has(sn)) {
      process.stdout.write(
        `  \x1b[31m! FOXESS_DEVICE_SN lists ${sn}, which is not on this account.\x1b[0m\n`,
      );
    }
  }

  const target = configured.find((sn) => known.has(sn)) ?? devices[0]!.deviceSN;

  // ── 3/3 live data ───────────────────────────────────────────────────────────
  heading(`3/3  Live data  (/op/v1/device/real/query, ${target})`);
  const [live] = await api.realQuery([target]);

  if (!live || live.datas.length === 0) {
    process.stdout.write('  \x1b[31mNo readings returned — the inverter may be offline.\x1b[0m\n');
    return 1;
  }

  const byName = new Map(live.datas.map((d) => [d.variable, d]));
  for (const variable of REAL_VARIABLES) {
    const datum = byName.get(variable);
    bullet(
      variable,
      datum === undefined
        ? '\x1b[90m— not reported by this inverter\x1b[0m'
        : `${datum.value}${datum.unit ? ` ${datum.unit}` : ''}`,
    );
  }

  const stamped = live.datas.find((d) => d.time)?.time;
  if (stamped) bullet('inverter time', stamped);

  const missing = REAL_VARIABLES.filter((v) => !byName.has(v));
  if (missing.length > 0) {
    process.stdout.write(
      `\n  \x1b[90mNot reported (normal for grid-tied inverters with no battery): ${missing.join(', ')}\x1b[0m\n`,
    );
  }

  heading('Result');
  process.stdout.write('  \x1b[32mCredentials, signature and endpoints all work.\x1b[0m\n');
  const after = budget.state();
  bullet('budget used', `${after.used}/${after.cap}`);
  process.stdout.write('\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write('\n\x1b[31mProbe failed.\x1b[0m\n\n');

    if (err instanceof FoxApiError) {
      process.stderr.write(`  errno ${err.errno} on ${err.path}\n  ${err.message}\n\n`);
      if (err.errno === 40256) {
        process.stderr.write(
          '  A 40256 nearly always means the signature is wrong or the key is invalid.\n' +
            '  Check that FOXESS_API_KEY matches the key in FoxESS Cloud -> User Profile ->\n' +
            '  API Management, and see docs/DECISIONS.md §1 for the signature rule.\n\n',
        );
      }
    } else {
      process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n\n`);
    }
    process.exit(1);
  },
);
