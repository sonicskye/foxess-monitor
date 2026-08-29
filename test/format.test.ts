/**
 * Tests for the frontend's pure formatting and direction logic.
 *
 * These decide what the display actually claims — whether the battery reads as charging or
 * discharging, and whether a low battery is flagged — so they are worth pinning even though the
 * rest of the UI is verified by screenshot.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  batteryDirection,
  clockTime,
  degrees,
  gridDirection,
  kw,
  kwh,
  percent,
  relativeAge,
  socLevel,
} from '../web/src/format.ts';

const TZ = 'Europe/London';

describe('kw', () => {
  test('two decimals under 10, one above', () => {
    assert.equal(kw(3.244), '3.24');
    assert.equal(kw(12.34), '12.3');
  });

  test('renders magnitude — direction is carried by a word elsewhere', () => {
    assert.equal(kw(-2.1), '2.10');
  });

  test('near-zero collapses to a clean zero rather than 0.004', () => {
    assert.equal(kw(0.004), '0.00');
    assert.equal(kw(0), '0.00');
  });

  test('missing data is an em dash, never 0', () => {
    // A grid-tied inverter reporting no battery must not read as "0.00 kW".
    assert.equal(kw(null), '—');
    assert.equal(kw(undefined), '—');
    assert.equal(kw(NaN), '—');
  });
});

describe('kwh', () => {
  test('compacts thousands', () => {
    assert.equal(kwh(8451.9), '8.5k');
  });

  test('scales precision with magnitude', () => {
    assert.equal(kwh(9.7), '9.70');
    assert.equal(kwh(19.73), '19.7');
  });

  test('missing is an em dash', () => {
    assert.equal(kwh(null), '—');
  });
});

describe('percent and degrees', () => {
  test('percent rounds to whole numbers', () => {
    assert.equal(percent(73.6), '74');
    assert.equal(percent(null), '—');
  });

  test('degrees keeps one decimal', () => {
    assert.equal(degrees(18.44), '18.4');
    assert.equal(degrees(null), '—');
  });
});

describe('gridDirection', () => {
  test('positive is importing, negative is exporting', () => {
    assert.equal(gridDirection(1.4), 'import');
    assert.equal(gridDirection(-2.1), 'export');
  });

  test('near zero is idle, not a direction', () => {
    assert.equal(gridDirection(0), 'idle');
    assert.equal(gridDirection(0.004), 'idle');
    assert.equal(gridDirection(-0.004), 'idle');
  });

  test('unknown is idle rather than a guess', () => {
    assert.equal(gridDirection(null), 'idle');
  });
});

describe('batteryDirection', () => {
  test('positive is charging, negative is discharging', () => {
    // Matches normalize.ts: positive = energy flowing INTO the thing named.
    assert.equal(batteryDirection(2.4), 'charging');
    assert.equal(batteryDirection(-1.8), 'discharging');
  });

  test('near zero is resting', () => {
    assert.equal(batteryDirection(0), 'idle');
    assert.equal(batteryDirection(null), 'idle');
  });
});

describe('socLevel', () => {
  test('drives the meter colour AND an icon plus word', () => {
    assert.equal(socLevel(74), 'normal');
    assert.equal(socLevel(14), 'low');
    assert.equal(socLevel(6), 'critical');
  });

  test('thresholds are 20% and 10%', () => {
    assert.equal(socLevel(20), 'normal');
    assert.equal(socLevel(19.9), 'low');
    assert.equal(socLevel(10), 'low');
    assert.equal(socLevel(9.9), 'critical');
  });

  test('unknown SOC is not alarmed as critical', () => {
    // A missing reading is a data problem, shown by the staleness badge — not a flat battery.
    assert.equal(socLevel(null), 'normal');
  });
});

describe('clockTime', () => {
  test('formats in the configured zone, 24-hour', () => {
    assert.equal(clockTime('2026-08-29T13:32:00Z', TZ), '14:32');
    assert.equal(clockTime(Date.parse('2026-01-15T13:32:00Z'), TZ), '13:32');
  });

  test('bad input is an em dash rather than "Invalid Date"', () => {
    assert.equal(clockTime('nonsense', TZ), '—');
    assert.equal(clockTime(null, TZ), '—');
  });
});

describe('relativeAge', () => {
  const now = Date.parse('2026-08-29T14:00:00Z');

  test('scales the unit with the age', () => {
    assert.equal(relativeAge(now - 30_000, now), '30s ago');
    assert.equal(relativeAge(now - 5 * 60_000, now), '5 min ago');
    assert.equal(relativeAge(now - 3 * 3600_000, now), '3 h ago');
    assert.equal(relativeAge(now - 2 * 86_400_000, now), '2 d ago');
  });

  test('never reports a negative age from clock skew', () => {
    assert.equal(relativeAge(now + 60_000, now), '0s ago');
  });

  test('unknown is stated, not guessed', () => {
    assert.equal(relativeAge(null, now), 'unknown');
  });
});
