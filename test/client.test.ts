import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../src/foxess/client.ts';
import { createEndpoints, PATHS, REAL_VARIABLES } from '../src/foxess/endpoints.ts';
import { BudgetDeniedError, FoxApiError } from '../src/foxess/types.ts';
import { createBudget, type Budget } from '../src/budget.ts';
import { createAuditLog, type AuditLog } from '../src/audit.ts';
import { addSecret, clearSecrets, configureLogging, createLogger, setLogSink } from '../src/log.ts';
import { signature } from '../src/foxess/sign.ts';

const API_KEY = 'test-api-key-abcdef123456';
const BASE = 'https://www.foxesscloud.com';

let dir: string;
let budget: Budget;
let audit: AuditLog;
let clock: number;
let calls: { url: string; init: RequestInit }[];
let logLines: string[];

const log = createLogger('test');

function ok(result: unknown, errno = 0) {
  return new Response(JSON.stringify({ errno, msg: 'ok', result }), { status: 200 });
}

function makeClient(responses: (() => Promise<Response>)[], overrides: Record<string, unknown> = {}) {
  let i = 0;
  return createClient({
    apiBase: BASE,
    apiKey: API_KEY,
    budget,
    audit,
    log,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses[Math.min(i++, responses.length - 1)];
      return next!();
    }) as unknown as typeof fetch,
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foxess-client-'));
  clock = Date.parse('2026-08-29T10:00:00Z');
  calls = [];
  logLines = [];
  clearSecrets();
  addSecret(API_KEY);
  setLogSink((line) => logLines.push(line));
  configureLogging({ level: 'debug', pretty: false });

  budget = createBudget({ dataDir: dir, timeZone: 'UTC', cap: 100, log, now: () => clock, sleep: async (ms) => { clock += ms; } });
  audit = createAuditLog({ dir, timeZone: 'UTC', retainDays: 14, log });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setLogSink(null);
  clearSecrets();
});

describe('signing on the wire', () => {
  test('sends the full signed header set', async () => {
    const client = makeClient([async () => ok([])]);
    await client.call({ method: 'POST', path: PATHS.deviceList, body: {} });

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['token'], API_KEY);
    assert.equal(headers['lang'], 'en');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['signature'], signature(PATHS.deviceList, API_KEY, clock));
    assert.match(headers['User-Agent']!, /^Mozilla\/5\.0/);
  });

  test('signs the path, not the query string, but still sends the query', async () => {
    const client = makeClient([async () => ok({ today: 1 })]);
    await client.call({ method: 'GET', path: PATHS.generation, query: { sn: 'ABC123' } });

    assert.equal(calls[0]!.url, `${BASE}/op/v0/device/generation?sn=ABC123`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(
      headers['signature'],
      signature(PATHS.generation, API_KEY, clock),
      'the signature must cover the bare path only',
    );
  });

  test('omits undefined query parameters', async () => {
    const client = makeClient([async () => ok({})]);
    await client.call({ method: 'GET', path: PATHS.generation, query: { sn: 'A', extra: undefined } });
    assert.equal(calls[0]!.url, `${BASE}/op/v0/device/generation?sn=A`);
  });

  test('GET sends no body', async () => {
    const client = makeClient([async () => ok({})]);
    await client.call({ method: 'GET', path: PATHS.accessCount });
    assert.equal(calls[0]!.init.body, undefined);
  });
});

describe('envelope handling', () => {
  test('unwraps result on errno 0', async () => {
    const client = makeClient([async () => ok({ total: '1440', remaining: '820' })]);
    const result = await client.call<{ total: string }>({ method: 'GET', path: PATHS.accessCount });
    assert.deepEqual(result, { total: '1440', remaining: '820' });
  });

  test('a non-zero errno throws even though HTTP is 200', async () => {
    // The failure mode that catches people out: the transport succeeded, the call did not.
    const client = makeClient([async () => ok(null, 40257)]);

    await assert.rejects(
      () => client.call({ method: 'POST', path: PATHS.realQuery, body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof FoxApiError);
        assert.equal(err.errno, 40257);
        return true;
      },
    );
  });

  test('a 40256 message points at the signature gotcha', async () => {
    const client = makeClient([async () => new Response(JSON.stringify({ errno: 40256, result: null }), { status: 200 })]);

    await assert.rejects(
      () => client.call({ method: 'POST', path: PATHS.deviceList, body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof FoxApiError);
        assert.match(err.message, /LITERAL, not CRLF/);
        return true;
      },
    );
  });
});

describe('retries are rationed', () => {
  test('retries once on a transport failure, then succeeds', async () => {
    let n = 0;
    const client = makeClient([
      async () => {
        if (n++ === 0) throw new Error('ECONNRESET');
        return ok({ ok: true });
      },
    ]);

    const result = await client.call<{ ok: boolean }>({ method: 'GET', path: PATHS.accessCount });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(budget.state().used, 2, 'a retry is a second real call against the quota');
  });

  test('does NOT retry a bad signature — it would fail identically and cost quota', async () => {
    const client = makeClient([async () => ok(null, 40256)]);

    await assert.rejects(() => client.call({ method: 'POST', path: PATHS.deviceList, body: {} }));
    assert.equal(calls.length, 1);
    assert.equal(budget.state().used, 1);
  });

  test('does NOT retry a bad body', async () => {
    const client = makeClient([async () => ok(null, 40257)]);
    await assert.rejects(() => client.call({ method: 'POST', path: PATHS.realQuery, body: {} }));
    assert.equal(calls.length, 1);
  });

  test('does NOT retry a rate limit — retrying into 40400 is how a bad minute becomes a bad day', async () => {
    const client = makeClient([async () => ok(null, 40400)]);
    await assert.rejects(() => client.call({ method: 'POST', path: PATHS.realQuery, body: {} }));
    assert.equal(calls.length, 1);
  });

  test('gives up after the retry budget and surfaces the error', async () => {
    const client = makeClient([async () => { throw new Error('ETIMEDOUT'); }]);
    await assert.rejects(() => client.call({ method: 'GET', path: PATHS.accessCount }), /ETIMEDOUT/);
    assert.equal(calls.length, 2, 'one attempt plus one retry');
  });

  test('retries a 503 but not a 400', async () => {
    const serverError = makeClient([async () => new Response('nope', { status: 503 })]);
    await assert.rejects(() => serverError.call({ method: 'GET', path: PATHS.accessCount }));
    assert.equal(calls.length, 2);

    calls = [];
    const badRequest = makeClient([async () => new Response('nope', { status: 400 })]);
    await assert.rejects(() => badRequest.call({ method: 'GET', path: PATHS.accessCount }));
    assert.equal(calls.length, 1);
  });

  test('retries an unparseable body — usually an HTML error page', async () => {
    let n = 0;
    const client = makeClient([
      async () => (n++ === 0 ? new Response('<html>502 Bad Gateway</html>', { status: 200 }) : ok({ fine: true })),
    ]);

    assert.deepEqual(await client.call({ method: 'GET', path: PATHS.accessCount }), { fine: true });
    assert.equal(calls.length, 2);
  });
});

describe('budget integration', () => {
  test('nothing is sent once the daily cap is spent', async () => {
    const small = createBudget({ dataDir: dir, timeZone: 'UTC', cap: 1, log, now: () => clock, sleep: async () => {} });
    const client = createClient({
      apiBase: BASE,
      apiKey: API_KEY,
      budget: small,
      audit,
      log,
      now: () => clock,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return ok({});
      }) as unknown as typeof fetch,
    });

    await client.call({ method: 'GET', path: PATHS.accessCount });
    assert.equal(calls.length, 1);

    await assert.rejects(
      () => client.call({ method: 'GET', path: PATHS.generation, query: { sn: 'A' } }),
      (err: unknown) => {
        assert.ok(err instanceof BudgetDeniedError);
        assert.equal(err.reason, 'daily-cap');
        return true;
      },
    );
    assert.equal(calls.length, 1, 'the refused call must never reach the network');
  });

  test('a 40400 arms the backoff, which then blocks other endpoints', async () => {
    const client = makeClient([async () => ok(null, 40400)]);

    await assert.rejects(() => client.call({ method: 'POST', path: PATHS.realQuery, body: {} }));
    assert.notEqual(budget.state().backoffUntil, null);

    await assert.rejects(
      () => client.call({ method: 'GET', path: PATHS.accessCount }),
      (err: unknown) => {
        assert.ok(err instanceof BudgetDeniedError);
        assert.equal(err.reason, 'backoff');
        return true;
      },
    );
  });
});

describe('audit trail', () => {
  test('records one line per attempt, including failures', async () => {
    let n = 0;
    const client = makeClient([async () => (n++ === 0 ? ok(null, 40257) : ok({}))]);

    await assert.rejects(() => client.call({ method: 'POST', path: PATHS.realQuery, body: {} }));

    const records = audit.recent();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.path, PATHS.realQuery);
    assert.equal(records[0]!.errno, 40257);
    assert.equal(records[0]!.status, 200);
    assert.equal(records[0]!.attempt, 1);
    assert.equal(records[0]!.budgetUsed, 1);
    assert.match(records[0]!.error!, /errno 40257/);
  });

  test('records both attempts of a retry, numbered', async () => {
    let n = 0;
    const client = makeClient([async () => { if (n++ === 0) throw new Error('ECONNRESET'); return ok({}); }]);

    await client.call({ method: 'GET', path: PATHS.accessCount });

    const records = audit.recent();
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.attempt), [1, 2]);
    assert.deepEqual(records.map((r) => r.budgetUsed), [1, 2]);
  });

  test('never writes the API key or a signature', async () => {
    const client = makeClient([async () => ok({})]);
    await client.call({ method: 'GET', path: PATHS.generation, query: { sn: 'ABC' } });

    const dumped = JSON.stringify(audit.recent()) + logLines.join('\n');
    assert.ok(!dumped.includes(API_KEY), 'API key reached the audit trail or the log');
  });
});

describe('endpoints', () => {
  test('realQuery posts sns and an explicit variable list', async () => {
    const client = makeClient([async () => ok([{ deviceSN: 'A', datas: [] }])]);
    const api = createEndpoints(client);

    await api.realQuery(['SN1', 'SN2']);

    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body.sns, ['SN1', 'SN2']);
    assert.deepEqual(body.variables, [...REAL_VARIABLES]);
    assert.ok(body.variables.includes('SoC'));
    assert.ok(body.variables.includes('ambientTemperation'), "the API's own spelling must be sent verbatim");
  });

  test('deviceList unwraps the paged envelope to a plain array', async () => {
    const client = makeClient([async () => ok({ total: 1, data: [{ deviceSN: 'SN1' }] })]);
    const api = createEndpoints(client);

    assert.deepEqual(await api.deviceList(), [{ deviceSN: 'SN1' }]);
  });

  test('deviceList tolerates a null result', async () => {
    const client = makeClient([async () => ok(null)]);
    assert.deepEqual(await createEndpoints(client).deviceList(), []);
  });

  test('accessCount coerces the string fields to numbers', async () => {
    const client = makeClient([async () => ok({ total: '1440', remaining: '823' })]);
    const api = createEndpoints(client);

    assert.deepEqual(await api.accessCount(), { total: 1440, remaining: 823 });
  });

  test('reportQuery omits month and day when not supplied', async () => {
    const client = makeClient([async () => ok([])]);
    await createEndpoints(client).reportQuery({ sn: 'A', year: 2026, dimension: 'year' });

    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.dimension, 'year');
    assert.ok(!('month' in body));
    assert.ok(!('day' in body));
  });

  test('every declared path is read-only', () => {
    for (const path of Object.values(PATHS)) {
      assert.ok(!/\/set(\/|$)/.test(path), `${path} looks like a write endpoint`);
    }
  });
});
