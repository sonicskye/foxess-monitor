/**
 * Local-day arithmetic in a configured IANA timezone.
 *
 * Three separate things hinge on "what day is it locally": the API budget counter (which resets at
 * local midnight), the sample day-files, and the audit day-files. They must agree, so the logic
 * lives here rather than being re-derived with `toISOString().slice(0, 10)` — which would silently
 * use UTC and roll the budget over at the wrong hour for most of the world.
 */

/** A local calendar day, `YYYY-MM-DD`. */
export type DayKey = string;

function parts(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const found = fmt.formatToParts(at);
  const get = (type: string): number => Number(found.find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** The local calendar day containing `at`, as `YYYY-MM-DD`. */
export function dayKey(at: Date, timeZone: string): DayKey {
  const { y, m, d } = parts(at, timeZone);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The UTC offset of `timeZone` at `at`, in minutes (positive east of Greenwich).
 *
 * Derived by formatting the instant as if it were UTC and differencing — the standard trick, and
 * correct across DST transitions because the offset is sampled at that instant.
 */
function offsetMinutes(at: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const f = fmt.formatToParts(at);
  const get = (type: string): number => Number(f.find((p) => p.type === type)?.value ?? '0');
  // `hour` can format as 24 for midnight under hour12:false; normalise to 0.
  const hour = get('hour') % 24;
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** Epoch ms of local midnight starting the day that contains `at`. */
export function startOfLocalDay(at: Date, timeZone: string): number {
  const { y, m, d } = parts(at, timeZone);
  // Guess using the offset at `at`, then re-solve with the offset actually in force at the
  // resulting instant. One correction is enough for every real-world DST rule.
  const guess = Date.UTC(y, m - 1, d) - offsetMinutes(at, timeZone) * 60000;
  const corrected = Date.UTC(y, m - 1, d) - offsetMinutes(new Date(guess), timeZone) * 60000;
  return corrected;
}

/** Epoch ms of the next local midnight after `at` — when the budget counter rolls over. */
export function startOfNextLocalDay(at: Date, timeZone: string): number {
  const today = startOfLocalDay(at, timeZone);
  // Step 36 h forward to land unambiguously inside the next day even across a DST shift, then
  // snap back to that day's midnight.
  return startOfLocalDay(new Date(today + 36 * 3600_000), timeZone);
}

/** `HH:mm` in the given timezone. */
export function localTimeHHMM(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/** True when `key` falls outside a `retainDays` window ending on the local day containing `at`. */
export function isExpired(key: DayKey, at: Date, timeZone: string, retainDays: number): boolean {
  const cutoffInstant = startOfLocalDay(at, timeZone) - (retainDays - 1) * 86_400_000;
  // Compare as calendar days, not instants: zero-padded ISO dates order correctly lexically.
  return key < dayKey(new Date(cutoffInstant), timeZone);
}
