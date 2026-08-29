import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, formatProjection, loadConfig, projectDailyCalls } from '../src/config.ts';
import { clearSecrets } from '../src/log.ts';

afterEach(() => clearSecrets());

const BASE = { FOXESS_API_KEY: 'a-real-looking-api-key-value', TZ: 'Europe/London' };

function expectProblems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
    assert.fail('expected loadConfig to throw');
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
    return err.problems;
  }
}

describe('defaults', () => {
  test('the shipped defaults are valid and fit the budget', () => {
    const cfg = loadConfig(BASE);

    assert.equal(cfg.poll.realSeconds, 90);
    assert.equal(cfg.poll.totalsSeconds, 600);
    assert.equal(cfg.poll.quotaSeconds, 3600);
    assert.equal(cfg.dailyCallBudget, 1400);
    assert.equal(cfg.apiBase, 'https://www.foxesscloud.com');
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.retainDays, 14);
    assert.equal(cfg.mock, false);
    assert.deepEqual(cfg.deviceSNs, []);
  });

  test('the default schedule leaves real headroom under 1440/day', () => {
    const cfg = loadConfig(BASE);
    const p = projectDailyCalls(cfg.poll, cfg.dailyCallBudget);

    assert.equal(p.total, 1276);
    assert.ok(p.withinBudget);
    assert.ok(p.total < 1440, 'must fit the true FoxESS ceiling, not just our own cap');
    assert.ok(1440 - p.total >= 100, 'needs headroom for restarts, retries and discovery');
  });
});

describe('budget pre-flight', () => {
  test('counts generation and report separately — they share one interval but are two calls', () => {
    const p = projectDailyCalls(
      { realSeconds: 90, totalsSeconds: 600, quotaSeconds: 3600, settingsSeconds: 21_600, idleSlowdownSeconds: 900, idlePollSeconds: 300 },
      1400,
    );
    const totals = p.jobs.filter((j) => j.intervalSeconds === 600);
    assert.equal(totals.length, 2);
    assert.equal(p.total, 960 + 144 + 144 + 24 + 4);
  });

  test('counts the battery settings job even though the poller may skip it', () => {
    // The poller skips it on a battery-less inverter, but the validator must never promise a
    // smaller number than the schedule could actually spend.
    const cfg = loadConfig(BASE);
    const settings = projectDailyCalls(cfg.poll, cfg.dailyCallBudget).jobs.find(
      (j) => j.name === 'battery/soc/get',
    );
    assert.ok(settings, 'the settings job must appear in the projection');
    assert.equal(settings.callsPerDay, 4, 'six-hourly');
  });

  test('refuses a schedule that would exhaust the day', () => {
    // 30s polling = 2880 real calls/day, double the entire FoxESS allowance.
    const problems = expectProblems({ ...BASE, POLL_REAL_SECONDS: '30' });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /would make 3196 API calls\/day/);
    assert.match(problems[0]!, /DAILY_CALL_BUDGET of 1400/);
    assert.match(problems[0]!, /Fix: raise POLL_REAL_SECONDS/);
  });

  test('60s real polling is rejected: it consumes the whole allowance alone', () => {
    const problems = expectProblems({ ...BASE, POLL_REAL_SECONDS: '60' });
    assert.match(problems[0]!, /would make 1756 API calls\/day/);
  });

  test('60s real polling cannot fit, however far everything else is dialled back', () => {
    // Worth pinning: 1440 real calls IS the entire FoxESS ceiling, so even reducing the totals and
    // quota jobs to once a day overshoots. One-minute polling is not achievable, and anyone who
    // tries should hit a clear refusal rather than a display that dies each afternoon.
    const p = projectDailyCalls(
      {
        realSeconds: 60,
        totalsSeconds: 86_400,
        quotaSeconds: 86_400,
        settingsSeconds: 86_400,
        idleSlowdownSeconds: 900,
        idlePollSeconds: 300,
      },
      1440,
    );
    assert.equal(p.total, 1444);
    assert.ok(!p.withinBudget, '1440 real calls leaves no room for anything else at all');
  });

  test('75s is the fastest live poll that still fits alongside the totals jobs', () => {
    const withTotals = (realSeconds: number) =>
      projectDailyCalls(
        { realSeconds, totalsSeconds: 600, quotaSeconds: 3600, settingsSeconds: 21_600, idleSlowdownSeconds: 900, idlePollSeconds: 300 },
        1440,
      ).total;

    assert.ok(withTotals(75) > 1440, `75s totals ${withTotals(75)}, over the ceiling`);
    assert.ok(withTotals(90) <= 1440, `90s totals ${withTotals(90)}, within the ceiling`);
  });

  test('the projection table names the offending job', () => {
    const p = projectDailyCalls(
      { realSeconds: 30, totalsSeconds: 600, quotaSeconds: 3600, settingsSeconds: 21_600, idleSlowdownSeconds: 900, idlePollSeconds: 300 },
      1400,
    );
    const table = formatProjection(p);
    assert.match(table, /device\/real\/query\s+every\s+30s -> \s*2880\/day/);
    assert.match(table, /battery\/soc\/get/);
    assert.match(table, /TOTAL/);
    assert.match(table, /228% of cap 1400/);
  });

  test('rejects an idle interval that is faster than the active one', () => {
    const problems = expectProblems({ ...BASE, POLL_REAL_SECONDS: '600', IDLE_POLL_SECONDS: '60' });
    assert.match(problems[0]!, /meant to slow polling down, not speed it up/);
  });
});

describe('validation', () => {
  test('requires an API key unless mocking', () => {
    const problems = expectProblems({ TZ: 'UTC' });
    assert.match(problems[0]!, /FOXESS_API_KEY is required/);
    assert.match(problems[0]!, /FOXESS_MOCK=1/, 'should point at the offline escape hatch');
  });

  test('mock mode runs with no API key', () => {
    const cfg = loadConfig({ FOXESS_MOCK: '1', TZ: 'UTC' });
    assert.equal(cfg.mock, true);
    assert.equal(cfg.apiKey, '');
  });

  test('reports every problem at once, not one per run', () => {
    const problems = expectProblems({ TZ: 'Mars/Olympus', PORT: 'eighty', LOG_LEVEL: 'chatty' });
    assert.ok(problems.length >= 4, `expected several problems, got ${problems.length}`);
    assert.ok(problems.some((p) => /FOXESS_API_KEY/.test(p)));
    assert.ok(problems.some((p) => /TZ is not a valid IANA timezone/.test(p)));
    assert.ok(problems.some((p) => /PORT must be an integer/.test(p)));
    assert.ok(problems.some((p) => /LOG_LEVEL must be one of/.test(p)));
  });

  test('rejects a daily budget above the FoxESS ceiling', () => {
    const problems = expectProblems({ ...BASE, DAILY_CALL_BUDGET: '5000' });
    assert.match(problems[0]!, /DAILY_CALL_BUDGET must be <= 1440/);
  });

  test('rejects a sub-30s poll interval outright', () => {
    const problems = expectProblems({ ...BASE, POLL_REAL_SECONDS: '5' });
    assert.match(problems[0]!, /POLL_REAL_SECONDS must be >= 30/);
  });

  test('normalises the API base to an origin', () => {
    const cfg = loadConfig({ ...BASE, FOXESS_API_BASE: 'https://portal.foxesscloud.us/some/path' });
    assert.equal(cfg.apiBase, 'https://portal.foxesscloud.us');
  });

  test('rejects more than 50 serials — the API caps sns at 50', () => {
    const sns = Array.from({ length: 51 }, (_, i) => `SN${i}`).join(',');
    const problems = expectProblems({ ...BASE, FOXESS_DEVICE_SN: sns });
    assert.match(problems[0]!, /at most 50/);
  });

  test('parses and trims a serial list', () => {
    const cfg = loadConfig({ ...BASE, FOXESS_DEVICE_SN: ' ABC123 , DEF456 ,, ' });
    assert.deepEqual(cfg.deviceSNs, ['ABC123', 'DEF456']);
  });
});

describe('secret registration', () => {
  test('registers the API key for redaction as a side effect of loading', async () => {
    const { redact, clearSecrets: clear } = await import('../src/log.ts');
    clear();
    loadConfig({ ...BASE, FOXESS_API_KEY: 'super-secret-key-1234' });

    const out = redact({ note: 'calling with super-secret-key-1234' }) as { note: string };
    assert.equal(out.note, 'calling with ***');
  });
});
