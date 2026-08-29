import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  SEPARATOR,
  signHeaders,
  signablePath,
  signature,
  signatureBase,
  USER_AGENT,
} from '../src/foxess/sign.ts';

const TOKEN = 'testtoken123456';
const TS = 1700000000000;

describe('signature — the literal \\r\\n rule', () => {
  test('GOLDEN VECTOR: /op/v0/device/list', () => {
    // Locked-in expectation. If this fails, the separator has been changed to CRLF and every API
    // call will return `40256 illegal signature`. See docs/DECISIONS.md §1 before touching it.
    assert.equal(signature('/op/v0/device/list', TOKEN, TS), '227a4a530e583495232d863248a4d8f3');
  });

  test('GOLDEN VECTOR: /op/v1/device/real/query', () => {
    assert.equal(
      signature('/op/v1/device/real/query', TOKEN, TS),
      'cf4ea614ea245362f91b1b11b1959769',
    );
  });

  test('the separator is four literal characters, not CR and LF', () => {
    assert.equal(SEPARATOR.length, 4);
    assert.deepEqual([...SEPARATOR], ['\\', 'r', '\\', 'n']);
    assert.ok(!SEPARATOR.includes('\r'), 'must not contain a carriage return');
    assert.ok(!SEPARATOR.includes('\n'), 'must not contain a line feed');
  });

  test('the CRLF variant produces a DIFFERENT digest', () => {
    // This is the trap. Both are plausible readings of the docs; only the literal one authenticates.
    const crlf = createHash('md5')
      .update(`/op/v0/device/list\r\n${TOKEN}\r\n${TS}`, 'utf8')
      .digest('hex');

    assert.equal(crlf, 'c7c109e077831abb55536a98f192d799');
    assert.notEqual(signature('/op/v0/device/list', TOKEN, TS), crlf);
  });

  test('the base string matches the reference Python raw f-string byte for byte', () => {
    // Python: fr'{path}\r\n{token}\r\n{timestamp}'
    assert.equal(
      signatureBase('/op/v0/device/list', TOKEN, TS),
      '/op/v0/device/list\\r\\ntesttoken123456\\r\\n1700000000000',
    );
  });

  test('digest is lowercase hex of length 32', () => {
    const sig = signature('/op/v0/device/list', TOKEN, TS);
    assert.match(sig, /^[0-9a-f]{32}$/);
  });

  test('accepts a string timestamp identically to a number', () => {
    assert.equal(signature('/op/v0/device/list', TOKEN, TS), signature('/op/v0/device/list', TOKEN, String(TS)));
  });
});

describe('signablePath', () => {
  test('drops the query string — signing it is the other way to get 40256', () => {
    assert.equal(signablePath('/op/v0/device/detail?sn=ABC123'), '/op/v0/device/detail');
  });

  test('drops the origin', () => {
    assert.equal(
      signablePath('https://www.foxesscloud.com/op/v0/device/list'),
      '/op/v0/device/list',
    );
  });

  test('drops origin and query together', () => {
    assert.equal(
      signablePath('https://www.foxesscloud.com/op/v0/device/generation?sn=ABC&x=1'),
      '/op/v0/device/generation',
    );
  });

  test('drops a fragment', () => {
    assert.equal(signablePath('/op/v0/device/list#frag'), '/op/v0/device/list');
  });

  test('leaves a bare path untouched', () => {
    assert.equal(signablePath('/op/v0/device/list'), '/op/v0/device/list');
  });

  test('adds a leading slash if missing', () => {
    assert.equal(signablePath('op/v0/device/list'), '/op/v0/device/list');
  });

  test('a signed URL and its path yield the same signature', () => {
    assert.equal(
      signature(signablePath('https://www.foxesscloud.com/op/v0/device/detail?sn=X'), TOKEN, TS),
      signature('/op/v0/device/detail', TOKEN, TS),
    );
  });
});

describe('signHeaders', () => {
  test('produces the full header set the API requires', () => {
    const h = signHeaders('/op/v0/device/list', TOKEN, { now: TS });

    assert.equal(h.token, TOKEN);
    assert.equal(h.timestamp, '1700000000000');
    assert.equal(h.signature, '227a4a530e583495232d863248a4d8f3');
    assert.equal(h.lang, 'en');
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(h['User-Agent'], USER_AGENT);
  });

  test('timestamp is milliseconds, not seconds', () => {
    const h = signHeaders('/op/v0/device/list', TOKEN);
    const ts = Number(h.timestamp);
    // 13 digits through the year 2286; a seconds value would be 10.
    assert.equal(h.timestamp.length, 13);
    assert.ok(Math.abs(ts - Date.now()) < 5000);
  });

  test('signs the path when handed a full URL with a query', () => {
    const h = signHeaders('https://www.foxesscloud.com/op/v0/device/detail?sn=X', TOKEN, { now: TS });
    assert.equal(h.signature, signature('/op/v0/device/detail', TOKEN, TS));
  });

  test('lang is overridable', () => {
    assert.equal(signHeaders('/x', TOKEN, { now: TS, lang: 'de' }).lang, 'de');
  });

  test('a browser User-Agent is sent — FoxESS rejects some default client UAs', () => {
    assert.match(USER_AGENT, /^Mozilla\/5\.0/);
  });
});
