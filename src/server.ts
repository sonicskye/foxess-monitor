/**
 * HTTP server: four API routes, an SSE stream and the static frontend.
 *
 * `node:http` with a hand-rolled router rather than a framework — see docs/DECISIONS.md §6. This is
 * four routes and a file handler on a machine with 4 GB of RAM.
 *
 * The browser talks only to this. It never sees the API key and never triggers a FoxESS call: it
 * reads a cache the poller maintains, so a hundred reloads cost nothing.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditLog } from './audit.ts';
import { createBudget } from './budget.ts';
import { ConfigError, formatProjection, loadConfig, projectDailyCalls, type Config } from './config.ts';
import { createClient } from './foxess/client.ts';
import { createEndpoints, type Endpoints } from './foxess/endpoints.ts';
import { configureLogging, createLogger, installCrashHandlers } from './log.ts';
import { createMockEndpoints } from './mock.ts';
import { createPoller, type Poller } from './poller.ts';
import { createSampleStore, downsample } from './store.ts';
import type { AuditLog } from './audit.ts';
import type { Budget } from './budget.ts';
import type { SampleStore } from './store.ts';

const log = createLogger('server');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Security headers sent on every response.
 *
 * `style-src` must allow inline styles: Preact sets `style={{…}}` for every series colour, meter
 * width and flow-diagram stroke, so blocking it would break the entire UI. Inline *style* is a far
 * smaller risk than inline *script*, and scripts stay locked to 'self' — which is why the theme
 * bootstrap lives in its own file rather than inline in index.html.
 *
 * `img-src` allows `data:` for the favicon, which is an inline SVG data URI.
 *
 * NOTE the deliberate absence of Strict-Transport-Security. This is plain HTTP on a LAN; HSTS would
 * tell the browser to force HTTPS on an origin that has none, locking every device that had once
 * visited out of the dashboard. A test asserts it stays absent.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  // MIME types here are derived from the file extension, so sniffing is a real risk.
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Always fresh: the poller decides what is current, not the browser cache.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export interface AppDeps {
  config: Config;
  poller: Poller;
  budget: Budget;
  audit: AuditLog;
  store: SampleStore;
  webRoot: string;
  /** Shifted in mock mode so the served day matches the simulated one. */
  now?: () => number;
}

/** Everything the dashboard needs for a first paint, in one response. */
function buildSnapshotPayload(deps: AppDeps) {
  const { poller, budget, config } = deps;
  const state = poller.state();
  const budgetState = budget.state();

  return {
    devices: state.devices,
    primarySN: state.devices[0]?.sn ?? null,
    snapshots: state.snapshots,
    snapshot: poller.primary(),
    totals: state.totals,
    generation: state.generation,
    battery: state.battery,
    quota: {
      used: budgetState.used,
      cap: budgetState.cap,
      remaining: budgetState.remaining,
      reportedTotal: budgetState.quotaTotal,
      reportedRemaining: budgetState.quotaRemaining,
    },
    poller: {
      idle: state.idle,
      startedAt: state.startedAt,
      pollSeconds: state.idle ? config.poll.idlePollSeconds : config.poll.realSeconds,
    },
    server: { timeZone: config.timeZone, mock: config.mock },
  };
}

/** Concurrent SSE streams allowed. A household uses ~4; this bounds a hostile LAN device. */
export const MAX_SSE_STREAMS = 32;

export function createApp(deps: AppDeps) {
  const { config, poller, budget, audit, store, webRoot } = deps;
  const now = deps.now ?? (() => Date.now());
  let openStreams = 0;

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    // Resolve inside webRoot only — a path such as /../../etc/passwd must not escape.
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = resolve(join(webRoot, relative));

    if (!file.startsWith(resolve(webRoot))) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (!existsSync(file) || statSync(file).isDirectory()) {
      // Single-page app: unknown paths fall back to index.html.
      file = join(webRoot, 'index.html');
    }

    if (!existsSync(file)) {
      res
        .writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Frontend not built yet. Run `npm run build:web`, or `npm run dev:web` for the dev server.');
      return;
    }

    const ext = extname(file);
    // Hashed asset filenames are immutable; index.html must never be cached or a deploy won't show.
    const immutable = /\/assets\//.test(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });

    const stream = createReadStream(file);
    // pipe() does NOT forward source errors, and an unhandled 'error' event throws — which would
    // reach the crash handler and take the whole process down. Reachable through the gap between
    // existsSync and the open, e.g. a deploy replacing web/dist while a page is being served.
    stream.on('error', (err) => {
      log.warn('static file read failed', { file, err });
      if (!res.headersSent) res.writeHead(500);
      res.end();
      stream.destroy();
    });
    stream.pipe(res);
  }

  function handleStream(req: IncomingMessage, res: ServerResponse): void {
    // Each stream holds a socket, a listener in the poller and a keepalive timer. A household runs
    // maybe four (kiosk, phone, tablet, laptop), so this is an order of magnitude of headroom while
    // still bounding what a hostile device on the LAN can allocate.
    if (openStreams >= MAX_SSE_STREAMS) {
      log.warn('refusing SSE connection — too many open streams', { open: openStreams });
      res.writeHead(503, { ...SECURITY_HEADERS, 'Retry-After': '10' }).end();
      return;
    }
    openStreams += 1;

    poller.noteViewerActivity();

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Paint immediately rather than waiting up to 90 s for the next poll.
    send('snapshot', buildSnapshotPayload(deps));

    const unsubscribe = poller.onSnapshot(() => send('snapshot', buildSnapshotPayload(deps)));

    // A comment frame keeps proxies and NAT tables from dropping an idle connection. It also
    // refreshes the viewer timestamp, which is what keeps the poller out of idle mode while the
    // kiosk is actually displaying something.
    const keepAlive = setInterval(() => {
      poller.noteViewerActivity();
      res.write(': keep-alive\n\n');
    }, 25_000);
    keepAlive.unref?.();

    let closed = false;
    const close = (): void => {
      // Guarded: 'close' and 'error' can both fire, and double-decrementing would leak slots
      // upward until the cap locked everyone out.
      if (closed) return;
      closed = true;
      openStreams -= 1;
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.on('close', close);
    req.on('error', close);
    res.on('error', close);
  }

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      route(req, res);
    } catch (err) {
      // Defence in depth. An exception thrown synchronously from a request listener becomes an
      // uncaughtException, which the crash handler turns into process.exit(1) — and with systemd's
      // StartLimitBurst, a handful of bad requests would leave the service permanently down. No
      // single request may ever be able to do that.
      log.error('request handler threw', { url: req.url, err });
      if (!res.headersSent) sendJson(res, 400, { error: 'Bad request' });
      else res.end();
    }
  };

  function route(req: IncomingMessage, res: ServerResponse): void {
    /*
     * Parsed against a FIXED base, never the Host header.
     *
     * Host is attacker-controlled and every malformed value throws ERR_INVALID_URL — "evil host",
     * "a b", "[", "%" and so on. Only pathname and searchParams are ever used, so the header is not
     * needed at all; dropping it removes the input rather than guarding it.
     */
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // The whole application is read-only; there is nothing to POST to.
      sendJson(res, 405, { error: 'This API is read-only' });
      return;
    }

    switch (pathname) {
      case '/healthz': {
        const snapshot = poller.primary();
        sendJson(res, 200, {
          ok: true,
          uptimeSeconds: Math.round(process.uptime()),
          devices: poller.state().devices.length,
          lastReadingAt: snapshot?.ts ?? null,
          stale: snapshot?.stale ?? null,
        });
        return;
      }

      case '/api/snapshot': {
        poller.noteViewerActivity();
        sendJson(res, 200, buildSnapshotPayload(deps));
        return;
      }

      case '/api/series': {
        poller.noteViewerActivity();
        const maxPoints = Math.min(2000, Math.max(20, Number(url.searchParams.get('points') ?? 240) || 240));
        const samples = store.readDay(new Date(now()));
        sendJson(res, 200, {
          range: 'today',
          timeZone: config.timeZone,
          series: downsample(samples, maxPoints),
          sampleCount: samples.length,
        });
        return;
      }

      case '/api/diagnostics': {
        const state = poller.state();
        sendJson(res, 200, {
          budget: budget.state(),
          jobs: state.jobs,
          devices: state.devices,
          idle: state.idle,
          startedAt: state.startedAt,
          uptimeSeconds: Math.round(process.uptime()),
          config: {
            // Deliberately excludes apiKey. Everything here is safe to show on the kiosk screen.
            apiBase: config.apiBase,
            timeZone: config.timeZone,
            mock: config.mock,
            poll: config.poll,
            dailyCallBudget: config.dailyCallBudget,
            retainDays: config.retainDays,
          },
          projection: projectDailyCalls(config.poll, config.dailyCallBudget),
          recentCalls: audit.recent(50),
        });
        return;
      }

      case '/api/stream': {
        handleStream(req, res);
        return;
      }

      default:
        serveStatic(req, res, pathname);
    }
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\n`);
      process.exit(2);
    }
    throw err;
  }

  configureLogging({ level: config.logLevel });
  installCrashHandlers(log);

  const projection = projectDailyCalls(config.poll, config.dailyCallBudget);
  log.info('polling budget', { total: projection.total, cap: projection.cap });
  if (!config.mock) process.stdout.write(`${formatProjection(projection)}\n`);

  const budget = createBudget({
    dataDir: config.dataDir,
    timeZone: config.timeZone,
    cap: config.dailyCallBudget,
    log: log.child('budget'),
  });
  const audit = createAuditLog({
    dir: config.dataDir,
    timeZone: config.timeZone,
    retainDays: config.retainDays,
    log: log.child('audit'),
  });
  const store = createSampleStore({
    dir: config.dataDir,
    timeZone: config.timeZone,
    retainDays: config.retainDays,
    log: log.child('store'),
  });

  const mockClock = (): number => Date.now() + config.mockOffsetHours * 3600_000;

  const api: Endpoints = config.mock
    ? createMockEndpoints({ timeZone: config.timeZone, now: mockClock })
    : createEndpoints(
        createClient({
          apiBase: config.apiBase,
          apiKey: config.apiKey,
          budget,
          audit,
          log: log.child('foxess'),
        }),
      );

  if (config.mock) {
    log.warn('FOXESS_MOCK=1 — serving synthetic data, making no API calls', {
      offsetHours: config.mockOffsetHours,
    });
  }

  const poller = createPoller({
    config,
    api,
    budget,
    audit,
    store,
    log: log.child('poller'),
    // In mock mode the whole app runs on the shifted clock, so samples and the simulation agree.
    ...(config.mock && config.mockOffsetHours !== 0 ? { now: mockClock } : {}),
  });

  const here = fileURLToPath(new URL('.', import.meta.url));
  // Works from both src/ (dev) and dist/ (built).
  const webRoot = resolve(here, '..', 'web', 'dist');

  const server = createServer(
    createApp({ config, poller, budget, audit, store, webRoot, now: config.mock ? mockClock : undefined }),
  );

  /*
   * Bounds, sized for a household rather than a datacentre.
   *
   * maxConnections is high enough that a kiosk, phones and tablets never notice, but low enough
   * that a hostile device on the LAN cannot exhaust sockets on a 4 GB machine. The timeouts are set
   * explicitly so they are a stated policy rather than whatever the Node default happens to be —
   * and requestTimeout must be 0 (disabled) or SSE streams, which are long-lived by design, would
   * be cut off mid-connection.
   */
  server.maxConnections = 256;
  server.headersTimeout = 20_000;
  server.requestTimeout = 0; // SSE never "finishes"; a timeout here would kill live updates
  server.keepAliveTimeout = 72_000; // comfortably above the 25s SSE keepalive frame

  // A restart racing the previous process is the common case here, and "uncaught exception" with a
  // stack is a poor way to say "the port is busy".
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `\nPort ${config.port} is already in use — another copy is probably still running.\n` +
          `  Check with:  ss -tlnp | grep ${config.port}\n` +
          `  Or set PORT to something else.\n\n`,
      );
      process.exit(2);
    }
    log.error('server error', { err });
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    log.info('listening', { url: `http://${config.host}:${config.port}`, webRoot });
  });

  await poller.start();

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    poller.stop();
    server.close(() => process.exit(0));
    // Don't hang forever on a browser holding an SSE connection open.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only run when executed directly, so tests can import createApp.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
