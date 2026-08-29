import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSecret,
  clearSecrets,
  configureLogging,
  createLogger,
  createTransitionLogger,
  redact,
  setLogSink,
} from '../src/log.ts';

const API_KEY = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  clearSecrets();
  setLogSink((line) => lines.push(line));
  configureLogging({ level: 'debug', pretty: false });
});

afterEach(() => {
  setLogSink(null);
  clearSecrets();
});

describe('redaction', () => {
  test('masks a registered secret anywhere in a string', () => {
    addSecret(API_KEY);
    const out = redact({ url: `https://example.com/x?token=${API_KEY}&a=1` }) as { url: string };
    assert.equal(out.url, 'https://example.com/x?token=***&a=1');
  });

  test('masks secret-named fields regardless of value', () => {
    const out = redact({
      token: 'anything',
      signature: 'deadbeef',
      Authorization: 'Bearer xyz',
      apiKey: 'k',
      safe: 'visible',
    }) as Record<string, unknown>;

    assert.equal(out['token'], '***');
    assert.equal(out['signature'], '***');
    assert.equal(out['Authorization'], '***', 'field matching must be case-insensitive');
    assert.equal(out['apiKey'], '***');
    assert.equal(out['safe'], 'visible');
  });

  test('reaches into nested objects and arrays', () => {
    addSecret(API_KEY);
    const out = redact({
      headers: [{ name: 'token', value: API_KEY }],
      deep: { deeper: { note: `key is ${API_KEY}` } },
    }) as any;

    assert.equal(out.headers[0].value, '***');
    assert.equal(out.deep.deeper.note, 'key is ***');
  });

  test('scrubs Error messages and stacks', () => {
    addSecret(API_KEY);
    const err = new Error(`request failed for token ${API_KEY}`);
    const out = redact({ err }) as { err: { message: string; stack: string } };

    assert.equal(out.err.message, 'request failed for token ***');
    assert.ok(!out.err.stack.includes(API_KEY));
  });

  test('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    assert.doesNotThrow(() => redact(node));
    assert.equal((redact(node) as any).self, '[Circular]');
  });

  test('ignores short values, which would over-redact ordinary text', () => {
    addSecret('abc');
    const out = redact({ msg: 'abc def' }) as { msg: string };
    assert.equal(out.msg, 'abc def');
  });
});

describe('logger output', () => {
  test('a registered key never reaches the sink, via message or fields', () => {
    addSecret(API_KEY);
    const log = createLogger('test');

    log.info(`calling with ${API_KEY}`, {
      headers: { token: API_KEY, signature: 'abc123' },
      url: `https://www.foxesscloud.com/op/v0/x?k=${API_KEY}`,
    });

    const all = lines.join('\n');
    assert.ok(!all.includes(API_KEY), 'API key leaked into log output');
    assert.ok(!all.includes('abc123'), 'signature leaked into log output');
  });

  test('emits one JSON line with the expected envelope', () => {
    createLogger('poller').warn('quota low', { remaining: 12 });

    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]!);
    assert.equal(rec.level, 'warn');
    assert.equal(rec.mod, 'poller');
    assert.equal(rec.msg, 'quota low');
    assert.equal(rec.remaining, 12);
    assert.ok(Date.parse(rec.ts) > 0);
  });

  test('respects the minimum level', () => {
    configureLogging({ level: 'warn', pretty: false });
    const log = createLogger('test');

    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');

    assert.equal(lines.length, 2);
  });

  test('child loggers namespace the module', () => {
    createLogger('foxess').child('client').info('hi');
    assert.equal(JSON.parse(lines[0]!).mod, 'foxess:client');
  });
});

describe('transition logger', () => {
  test('logs only on change, not on every call', () => {
    const log = createLogger('poller');
    const track = createTransitionLogger<boolean>(log, (_from, to) => ({
      level: to ? 'warn' : 'info',
      msg: to ? 'inverter went stale' : 'inverter recovered',
    }));

    // A stale inverter polled 100 times must not produce 100 log lines.
    assert.equal(track(true), true);
    for (let i = 0; i < 100; i++) track(true);
    assert.equal(lines.length, 1);

    assert.equal(track(false), true);
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /recovered/);
  });

  test('suppresses the line when the renderer returns null', () => {
    const log = createLogger('poller');
    const track = createTransitionLogger<boolean>(log, (from, to) =>
      from === undefined && to === false ? null : { level: 'info', msg: `now ${to}` },
    );

    track(false); // initial healthy state: nothing worth saying
    assert.equal(lines.length, 0);
    track(true);
    assert.equal(lines.length, 1);
  });
});
