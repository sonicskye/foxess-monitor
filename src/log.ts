/**
 * Structured logging with secret redaction.
 *
 * One line per record: JSON when stdout is piped (systemd journal), human-readable when it is a
 * TTY. Zero dependencies.
 *
 * Everything in this project logs through here for one reason: the FoxESS API key is not
 * read-only — it can change inverter settings. A key leaked into a journal that survives on disk
 * for months is the worst failure this codebase can have, so redaction is centralised and
 * unconditional rather than left to each call site to remember.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

export type Fields = Record<string, unknown>;

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values are always masked, whatever they contain. */
const SECRET_KEYS = new Set([
  'token',
  'signature',
  'authorization',
  'apikey',
  'api_key',
  'foxess_api_key',
  'key',
  'secret',
  'password',
  'access_token',
  'refresh_token',
  'client_secret',
]);

const MASK = '***';

/**
 * Literal secrets to scrub from anywhere in a record — including the middle of a URL, an error
 * message, or a stack trace, where they would never be caught by field name alone.
 */
const secrets = new Set<string>();

/**
 * Register a value to be masked everywhere it appears.
 *
 * Values shorter than 8 characters are ignored: they are too likely to occur incidentally in
 * ordinary text, and over-redaction would make logs useless without making them safer.
 */
export function addSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

/** Test seam. */
export function clearSecrets(): void {
  secrets.clear();
}

function scrubString(input: string): string {
  let out = input;
  for (const secret of secrets) out = out.replaceAll(secret, MASK);
  return out;
}

/**
 * Recursively mask secrets in a value: by field name, by literal match inside strings, and inside
 * Error messages and stacks. Cycles are broken with `[Circular]`.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? MASK : redact(val, seen);
  }
  return out;
}

function parseLevel(raw: string | undefined): Level {
  const v = (raw ?? 'info').toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

function parsePretty(raw: string | undefined): boolean {
  const v = (raw ?? 'auto').toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return process.stdout.isTTY === true; // 'auto'
}

let minLevel = parseLevel(process.env['LOG_LEVEL']);
let pretty = parsePretty(process.env['LOG_PRETTY']);

/** Re-read LOG_LEVEL / LOG_PRETTY. Called once after config load, and by tests. */
export function configureLogging(opts: { level?: Level; pretty?: boolean } = {}): void {
  minLevel = opts.level ?? parseLevel(process.env['LOG_LEVEL']);
  pretty = opts.pretty ?? parsePretty(process.env['LOG_PRETTY']);
}

/** Test seam: capture output instead of writing to stdout. */
let sink: (line: string) => void = (line) => process.stdout.write(line + '\n');

export function setLogSink(fn: ((line: string) => void) | null): void {
  sink = fn ?? ((line) => process.stdout.write(line + '\n'));
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const LEVEL_COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function formatPretty(level: Level, mod: string, msg: string, fields: Fields): string {
  const time = new Date().toISOString().slice(11, 19);
  const color = LEVEL_COLOR[level];
  const head = `${DIM}${time}${RESET} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${DIM}${mod}${RESET} ${msg}`;
  const rest = Object.entries(fields)
    .map(([k, v]) => `${DIM}${k}=${RESET}${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return rest ? `${head} ${rest}` : head;
}

function emit(level: Level, mod: string, msg: string, fields: Fields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const safeMsg = scrubString(msg);
  const safeFields = redact(fields) as Fields;

  if (pretty) {
    sink(formatPretty(level, mod, safeMsg, safeFields));
  } else {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, mod, msg: safeMsg, ...safeFields }));
  }
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(mod: string): Logger;
}

export function createLogger(mod: string): Logger {
  return {
    debug: (msg, fields = {}) => emit('debug', mod, msg, fields),
    info: (msg, fields = {}) => emit('info', mod, msg, fields),
    warn: (msg, fields = {}) => emit('warn', mod, msg, fields),
    error: (msg, fields = {}) => emit('error', mod, msg, fields),
    child: (sub) => createLogger(`${mod}:${sub}`),
  };
}

/**
 * Log a state change only when it actually changes.
 *
 * The inverter going offline is worth one line, not one line every 90 seconds for eight hours —
 * a log that repeats is a log nobody reads. Returns true when the transition was logged.
 */
export function createTransitionLogger<T>(
  log: Logger,
  render: (from: T | undefined, to: T) => { level: Level; msg: string; fields?: Fields } | null,
) {
  let current: T | undefined;
  let primed = false;

  return (next: T): boolean => {
    if (primed && Object.is(current, next)) return false;
    const previous = current;
    current = next;
    primed = true;

    const entry = render(previous, next);
    if (!entry) return false;
    log[entry.level](entry.msg, entry.fields ?? {});
    return true;
  };
}

/** Attach process-level handlers so a crash is explained before systemd restarts us. */
export function installCrashHandlers(log: Logger): void {
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception — exiting', { err });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection — exiting', { err: reason });
    process.exit(1);
  });
}
