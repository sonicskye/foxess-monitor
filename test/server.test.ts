import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { createApp, MAX_SSE_STREAMS } from '../src/server.ts';
import { createPoller, type Poller } from '../src/poller.ts';
import { createMockEndpoints, MOCK_SN } from '../src/mock.ts';
import { createBudget, type Budget } from '../src/budget.ts';
import { createAuditLog, type AuditLog } from '../src/audit.ts';
import { createSampleStore, type SampleStore } from '../src/store.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { configureLogging, createLogger, setLogSink } from '../src/log.ts';

const TZ = 'Europe/London';
const log = createLogger('test');

let dir: string;
let config: Config;
let budget: Budget;
let audit: AuditLog;
let store: SampleStore;
let poller: Poller;
let server: Server;
let base: string;

/** Fixed simulated instant: mid-afternoon, so solar is up and the battery is active. */
const NOW = Date.parse('2026-08-29T13:00:00Z');

async function get(path: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — some routes serve text */
  }
  return { status: res.status, json, text };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'foxess-server-'));
  setLogSink(() => {});
  configureLogging({ level: 'error', pretty: false });

  config = loadConfig({ FOXESS_MOCK: '1', TZ, DATA_DIR: dir });

  budget = createBudget({ dataDir: dir, timeZone: TZ, cap: config.dailyCallBudget, log });
  audit = createAuditLog({ dir, timeZone: TZ, retainDays: 14, log });
  store = createSampleStore({ dir, timeZone: TZ, retainDays: 14, log });

  poller = createPoller({
    config,
    api: createMockEndpoints({ timeZone: TZ, now: () => NOW }),
    budget,
    audit,
    store,
    log,
    now: () => NOW,
  });
  await poller.start();

  server = createServer(
    createApp({ config, poller, budget, audit, store, webRoot: join(dir, 'web'), now: () => NOW }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  poller.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  setLogSink(null);
});

describe('/api/snapshot', () => {
  test('serves a complete first paint in one response', async () => {
    const { status, json } = await get('/api/snapshot');

    assert.equal(status, 200);
    assert.equal(json.primarySN, MOCK_SN);
    assert.equal(json.devices.length, 1);
    assert.equal(json.devices[0].stationName, 'Mock House');
    assert.ok(json.snapshot, 'a snapshot must be present immediately, not after the first poll');
    assert.ok(json.totals, 'day totals must be present');
    assert.ok(json.generation, 'generation summary must be present');
    assert.ok(json.quota.cap > 0);
    assert.equal(json.server.mock, true);
    assert.equal(json.server.timeZone, TZ);
  });

  test('the snapshot carries normalised, signed values', async () => {
    const { json } = await get('/api/snapshot');
    const s = json.snapshot;

    assert.equal(s.deviceSN, MOCK_SN);
    assert.equal(typeof s.soc, 'number');
    assert.ok(s.soc >= 0 && s.soc <= 100);
    assert.equal(typeof s.solarKw, 'number');
    assert.equal(typeof s.gridKw, 'number');
    assert.equal(s.stale, false);
  });

  test('carries stored / usable / reserved battery energy', async () => {
    const { json } = await get('/api/snapshot');
    const b = json.battery;

    // The mock reserves 20% on-grid of a 10.4 kWh pack.
    assert.equal(b.floorPercent, 20);
    assert.ok(b.capacityKwh > 9 && b.capacityKwh < 12, `capacity ${b.capacityKwh}`);
    assert.ok(b.reservedKwh > 0);
    assert.ok(
      b.usableKwh < b.storedKwh,
      'usable must be less than stored — that is the whole point of the reserve',
    );
    assert.equal(b.usableKwh.toFixed(2), (b.storedKwh - b.reservedKwh).toFixed(2));
  });

  test('never exposes the API key', async () => {
    const { text } = await get('/api/snapshot');
    assert.ok(!/apiKey|FOXESS_API_KEY|token/i.test(text), 'no credential-shaped field may be served');
  });

  test('is marked no-store so the kiosk cannot show a cached reading', async () => {
    const res = await fetch(`${base}/api/snapshot`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('/api/series', () => {
  test('serves today from the backfilled samples', async () => {
    const { status, json } = await get('/api/series');

    assert.equal(status, 200);
    assert.equal(json.range, 'today');
    assert.ok(json.sampleCount > 0, 'startup backfill should have populated today');
    assert.equal(json.series.t.length, json.series.solarKw.length);
    assert.equal(json.series.t.length, json.series.soc.length);
  });

  test('honours the points parameter', async () => {
    const { json } = await get('/api/series?points=30');
    assert.ok(json.series.t.length <= 31, `got ${json.series.t.length}`);
  });

  test('clamps an absurd points value instead of trusting it', async () => {
    const { status: high } = await get('/api/series?points=999999');
    const { status: low } = await get('/api/series?points=-5');
    const { status: junk } = await get('/api/series?points=abc');
    assert.deepEqual([high, low, junk], [200, 200, 200]);
  });

  test('continuous data produces no spurious gaps', async () => {
    // Regression guard for the downsampler: coarse buckets must not read as outages.
    const { json } = await get('/api/series?points=24');
    assert.ok(!json.series.soc.includes(null), 'an unbroken day must render as an unbroken line');
  });
});

describe('/api/diagnostics', () => {
  test('reports budget, jobs and projection', async () => {
    const { status, json } = await get('/api/diagnostics');

    assert.equal(status, 200);
    assert.equal(json.budget.cap, config.dailyCallBudget);
    assert.ok('real' in json.jobs, 'the live poll job must be listed');
    assert.ok('totals' in json.jobs);
    assert.equal(json.projection.total, 1276);
    assert.ok(Array.isArray(json.recentCalls));
  });

  test('exposes config WITHOUT the API key', async () => {
    const { json, text } = await get('/api/diagnostics');

    assert.equal(json.config.timeZone, TZ);
    assert.equal(json.config.dailyCallBudget, 1400);
    assert.ok(!('apiKey' in json.config), 'the key must never reach the diagnostics panel');
    assert.ok(!/apiKey/.test(text));
  });
});

describe('/healthz', () => {
  test('reports liveness and staleness', async () => {
    const { status, json } = await get('/healthz');

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.devices, 1);
    assert.equal(json.stale, false);
    assert.ok(json.lastReadingAt);
  });
});

describe('/api/stream', () => {
  test('pushes a snapshot immediately on connect', async () => {
    // The kiosk must paint on connect, not sit blank until the next 90s poll.
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: controller.signal });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);

    assert.match(chunk, /^event: snapshot/m);
    const payload = JSON.parse(/data: (.*)/.exec(chunk)![1]!);
    assert.equal(payload.primarySN, MOCK_SN);

    controller.abort();
  });

  test('a connection takes the poller out of idle mode', async () => {
    const controller = new AbortController();
    await fetch(`${base}/api/stream`, { signal: controller.signal });

    assert.equal(poller.state().idle, false);
    controller.abort();
  });
});

describe('security: no single request may kill the process', () => {
  /** Send a raw request so we can set headers `fetch` refuses to. */
  function raw(request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const port = Number(new URL(base).port);
      const sock = connect(port, '127.0.0.1', () => sock.write(request));
      let out = '';
      sock.on('data', (d) => {
        out += d.toString();
      });
      sock.on('error', reject);
      setTimeout(() => {
        sock.destroy();
        resolve(out);
      }, 250);
    });
  }

  test('a malformed Host header is answered, not fatal', async () => {
    // The high-severity finding. `new URL(url, "http://" + host)` threw ERR_INVALID_URL, which
    // became an uncaughtException and exited the process; with systemd's StartLimitBurst, five of
    // these left the dashboard permanently down. Only pathname/search are used, so the Host header
    // is not consulted at all now.
    for (const host of ['evil host', 'a b', '[', '%', 'host:notaport', '']) {
      const response = await raw(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
      assert.match(response, /^HTTP\/1\.1 200/, `Host: ${JSON.stringify(host)} was not answered`);
    }

    // Still serving afterwards — the point of the test.
    const { status } = await get('/healthz');
    assert.equal(status, 200, 'the server died');
  });

  test('an absent Host header (HTTP/1.0) is fine too', async () => {
    const response = await raw('GET /healthz HTTP/1.0\r\n\r\n');
    assert.match(response, /^HTTP\/1\.[01] 200/);
  });

  test('an unreadable static file returns 500 rather than crashing', async () => {
    // pipe() does not forward source errors, and an unhandled 'error' event throws.
    const webDir = join(dir, 'web');
    mkdirSync(webDir, { recursive: true });
    const file = join(webDir, 'index.html');
    writeFileSync(file, '<html></html>');
    chmodSync(file, 0o000);

    const { status } = await get('/');
    // Running as root would still be able to read it; accept either, but never a dead server.
    assert.ok(status === 500 || status === 200, `unexpected ${status}`);

    chmodSync(file, 0o644);
    assert.equal((await get('/healthz')).status, 200, 'the server died');
  });
});

describe('security: response headers', () => {
  test('every response carries the hardening headers', async () => {
    for (const path of ['/api/snapshot', '/healthz', '/']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
      assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/, path);
    }
  });

  test('the CSP locks scripts down but must allow inline styles', async () => {
    const csp = (await fetch(`${base}/api/snapshot`)).headers.get('content-security-policy') ?? '';

    assert.match(csp, /script-src 'self'/, 'scripts must not allow inline');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'inline scripts must stay blocked');
    // Preact sets style={{…}} for every series colour and meter width; blocking it breaks the UI.
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /img-src 'self' data:/, 'the favicon is a data: URI');
  });

  test('HSTS is deliberately absent — it would lock users out over plain HTTP', async () => {
    // This dashboard is HTTP on a LAN. HSTS would force HTTPS on an origin that has none, and
    // persist in the browser, breaking access from any device that had visited once.
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.headers.get('strict-transport-security'), null);
  });
});

describe('security: connection limits leave normal LAN use alone', () => {
  test('several simultaneous viewers all get their stream', async () => {
    // A kiosk, a phone and a tablet at once — the case the cap must never interfere with.
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const responses = await Promise.all(
      controllers.map((c) => fetch(`${base}/api/stream`, { signal: c.signal })),
    );

    assert.ok(responses.every((r) => r.status === 200), 'a normal number of viewers was refused');
    controllers.forEach((c) => c.abort());
  });

  test('past the cap it refuses politely instead of falling over', async () => {
    const controllers = Array.from({ length: MAX_SSE_STREAMS }, () => new AbortController());
    await Promise.all(controllers.map((c) => fetch(`${base}/api/stream`, { signal: c.signal })));

    const overflow = await fetch(`${base}/api/stream`);
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers.get('retry-after'), '10');
    await overflow.text();

    controllers.forEach((c) => c.abort());
    // Slots must come back, or one burst would lock the dashboard out for good.
    await new Promise((r) => setTimeout(r, 150));

    const after = new AbortController();
    const recovered = await fetch(`${base}/api/stream`, { signal: after.signal });
    assert.equal(recovered.status, 200, 'closing streams did not free their slots');
    after.abort();
  });
});

describe('read-only enforcement', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    test(`${method} is refused`, async () => {
      const res = await fetch(`${base}/api/snapshot`, { method });
      assert.equal(res.status, 405);
      assert.match((await res.json()).error, /read-only/);
    });
  }
});

describe('static file serving', () => {
  test('refuses to escape the web root', async () => {
    // Encoded traversal must not read arbitrary files off the laptop.
    for (const attack of [
      '/../../../../etc/passwd',
      '/..%2f..%2f..%2fetc%2fpasswd',
      '/%2e%2e/%2e%2e/etc/passwd',
    ]) {
      const { status, text } = await get(attack);
      assert.ok(status === 403 || status === 503, `${attack} returned ${status}`);
      assert.ok(!text.includes('root:'), `${attack} leaked /etc/passwd`);
    }
  });

  test('explains itself when the frontend is not built', async () => {
    const { status, text } = await get('/');
    assert.equal(status, 503);
    assert.match(text, /npm run build:web/);
  });
});

describe('poller', () => {
  test('discovers the mock inverter and records samples', () => {
    const state = poller.state();

    assert.equal(state.devices.length, 1);
    assert.equal(state.devices[0]!.sn, MOCK_SN);
    assert.ok(store.readDay(new Date(NOW)).length > 0, 'the startup backfill must land on disk');
  });

  test('mock mode spends no budget', () => {
    assert.equal(budget.state().used, 0, 'mock mode must never touch the real quota');
  });

  test('job health is tracked for the schedule', () => {
    const { jobs } = poller.state();

    for (const name of ['discover', 'backfill', 'real', 'totals', 'generation', 'quota', 'settings']) {
      assert.ok(jobs[name], `missing job ${name}`);
      assert.equal(jobs[name]!.lastError, null, `${name} failed: ${jobs[name]!.lastError}`);
      assert.ok(jobs[name]!.runs > 0);
    }
  });

  test('onSnapshot returns a working unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = poller.onSnapshot((s) => seen.push(s.deviceSN));
    unsubscribe();
    // Delivery itself is covered by the SSE test, which observes a real pushed frame.
    assert.equal(typeof unsubscribe, 'function');
    assert.deepEqual(seen, []);
  });
});
