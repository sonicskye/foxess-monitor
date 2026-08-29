import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey,
  isExpired,
  localTimeHHMM,
  startOfLocalDay,
  startOfNextLocalDay,
} from '../src/localdate.ts';

const LONDON = 'Europe/London';
const SYDNEY = 'Australia/Sydney';

describe('dayKey', () => {
  test('uses the local calendar day, not UTC', () => {
    // 23:30 UTC on 29 Aug is already 09:30 on 30 Aug in Sydney.
    const at = new Date('2026-08-29T23:30:00Z');
    assert.equal(dayKey(at, 'UTC'), '2026-08-29');
    assert.equal(dayKey(at, SYDNEY), '2026-08-30');
  });

  test('zero-pads so keys sort lexically', () => {
    assert.equal(dayKey(new Date('2026-01-05T12:00:00Z'), 'UTC'), '2026-01-05');
  });
});

describe('startOfLocalDay', () => {
  test('is local midnight during BST (UTC+1)', () => {
    const at = new Date('2026-08-29T14:00:00Z');
    assert.equal(new Date(startOfLocalDay(at, LONDON)).toISOString(), '2026-08-28T23:00:00.000Z');
  });

  test('is local midnight during GMT (UTC+0)', () => {
    const at = new Date('2026-01-15T14:00:00Z');
    assert.equal(new Date(startOfLocalDay(at, LONDON)).toISOString(), '2026-01-15T00:00:00.000Z');
  });

  test('is idempotent — midnight maps to itself', () => {
    const at = new Date('2026-08-29T14:00:00Z');
    const midnight = startOfLocalDay(at, LONDON);
    assert.equal(startOfLocalDay(new Date(midnight), LONDON), midnight);
  });

  test('handles a southern-hemisphere zone across the date line', () => {
    const at = new Date('2026-08-29T23:30:00Z'); // 09:30 Aug 30 in Sydney
    assert.equal(new Date(startOfLocalDay(at, SYDNEY)).toISOString(), '2026-08-29T14:00:00.000Z');
  });
});

describe('startOfNextLocalDay', () => {
  test('advances exactly one calendar day', () => {
    const at = new Date('2026-08-29T14:00:00Z');
    const next = startOfNextLocalDay(at, LONDON);
    assert.equal(dayKey(new Date(next), LONDON), '2026-08-30');
    assert.equal(new Date(next).toISOString(), '2026-08-29T23:00:00.000Z');
  });

  test('crosses the spring DST boundary without skipping a day', () => {
    // UK clocks go forward at 01:00 UTC on 2026-03-29; that day is only 23 hours long.
    const at = new Date('2026-03-28T12:00:00Z');
    const next = startOfNextLocalDay(at, LONDON);
    assert.equal(dayKey(new Date(next), LONDON), '2026-03-29');
  });

  test('crosses the autumn DST boundary without repeating a day', () => {
    // UK clocks go back at 02:00 local on 2026-10-25; that day is 25 hours long.
    const at = new Date('2026-10-25T12:00:00Z');
    const next = startOfNextLocalDay(at, LONDON);
    assert.equal(dayKey(new Date(next), LONDON), '2026-10-26');
    // The budget must roll over at real local midnight, not 23:00 or 01:00.
    assert.equal(new Date(next).toISOString(), '2026-10-26T00:00:00.000Z');
  });
});

describe('isExpired', () => {
  const now = new Date('2026-08-29T14:00:00Z');

  test('keeps today and the retention window', () => {
    assert.equal(isExpired('2026-08-29', now, LONDON, 14), false);
    assert.equal(isExpired('2026-08-16', now, LONDON, 14), false, '14th day back is still in range');
  });

  test('drops anything older than the window', () => {
    assert.equal(isExpired('2026-08-15', now, LONDON, 14), true);
    assert.equal(isExpired('2025-01-01', now, LONDON, 14), true);
  });

  test('a one-day window keeps only today', () => {
    assert.equal(isExpired('2026-08-29', now, LONDON, 1), false);
    assert.equal(isExpired('2026-08-28', now, LONDON, 1), true);
  });
});

describe('localTimeHHMM', () => {
  test('formats 24-hour local time', () => {
    assert.equal(localTimeHHMM(new Date('2026-08-29T13:32:00Z'), LONDON), '14:32');
    assert.equal(localTimeHHMM(new Date('2026-01-15T13:32:00Z'), LONDON), '13:32');
  });

  test('renders midnight as 00:00, never 24:00', () => {
    assert.equal(localTimeHHMM(new Date('2026-01-15T00:00:00Z'), LONDON), '00:00');
  });
});
