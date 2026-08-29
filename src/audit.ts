/**
 * The API call audit trail.
 *
 * Every single FoxESS request gets one line in `data/api-calls-YYYY-MM-DD.ndjson`. This is what
 * makes the budget model falsifiable: after a day's run you can count the lines, compare
 * `budgetUsed` against the `quotaRemaining` FoxESS itself reported, and know whether the schedule
 * behaved. Without it, a quota blowout at 14:00 is unexplainable after the fact.
 *
 * Day-files rather than one rolling file: pruning is then an unlink, never a rewrite. This runs on
 * a laptop that may lose power at any moment, and rewriting the whole history to drop old lines is
 * the one operation that could lose all of it.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './log.ts';
import { redact } from './log.ts';
import { dayKey, isExpired } from './localdate.ts';

export interface AuditRecord {
  /** ISO instant the request completed. */
  ts: string;
  path: string;
  /** Round-trip duration in ms. */
  ms: number;
  /** HTTP status, or 0 if the request never completed. */
  status: number;
  /** FoxESS `errno` from the body; null when the body could not be parsed. */
  errno: number | null;
  bytes: number;
  /** Calls the local counter had spent today, including this one. */
  budgetUsed: number;
  budgetCap: number;
  /** `remaining` as last reported by getAccessCount, or null if not yet known. */
  quotaRemaining: number | null;
  /** 1 for the first try, 2+ for retries. */
  attempt: number;
  error?: string;
}

const FILE_PREFIX = 'api-calls-';
const FILE_SUFFIX = '.ndjson';

export interface AuditLog {
  record(rec: AuditRecord): void;
  /** Most recent records, newest last, for `/api/diagnostics`. */
  recent(limit?: number): AuditRecord[];
  /** Delete day-files outside the retention window. Safe to call repeatedly. */
  prune(now?: Date): void;
}

export function createAuditLog(opts: {
  dir: string;
  timeZone: string;
  retainDays: number;
  log: Logger;
  /** Records held in memory for the diagnostics endpoint. */
  memoryLimit?: number;
}): AuditLog {
  const { dir, timeZone, retainDays, log } = opts;
  const memoryLimit = opts.memoryLimit ?? 200;
  const buffer: AuditRecord[] = [];

  mkdirSync(dir, { recursive: true });

  return {
    record(rec) {
      buffer.push(rec);
      if (buffer.length > memoryLimit) buffer.splice(0, buffer.length - memoryLimit);

      const file = join(dir, `${FILE_PREFIX}${dayKey(new Date(rec.ts), timeZone)}${FILE_SUFFIX}`);
      try {
        // Redacted like everything else: a path or error string could carry a signature.
        appendFileSync(file, JSON.stringify(redact(rec)) + '\n');
      } catch (err) {
        // Never let the audit trail take down a poll it was only observing.
        log.warn('could not append to audit trail', { file, err });
      }
    },

    recent(limit = 50) {
      return buffer.slice(-limit);
    },

    prune(now = new Date()) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch (err) {
        log.warn('could not read data dir for pruning', { dir, err });
        return;
      }
      for (const name of entries) {
        if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
        const key = name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
        if (!isExpired(key, now, timeZone, retainDays)) continue;
        try {
          unlinkSync(join(dir, name));
          log.debug('pruned expired audit file', { file: name });
        } catch (err) {
          log.warn('could not prune audit file', { file: name, err });
        }
      }
    },
  };
}
