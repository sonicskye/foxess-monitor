/**
 * The dashboard.
 *
 * Laid out to fit 1366×768 (the target laptop's panel) without scrolling — a wall display that
 * needs scrolling has failed at its one job.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  fetchSeries,
  subscribe,
  type ConnectionState,
  type SeriesPayload,
  type SnapshotPayload,
} from './api.ts';
import { FlowDiagram } from './components/FlowDiagram.tsx';
import { SocMeter } from './components/SocMeter.tsx';
import { StatTile } from './components/StatTile.tsx';
import { IntradayChart } from './components/IntradayChart.tsx';
import { Diagnostics } from './components/Diagnostics.tsx';
import {
  batteryDirection,
  clockTime,
  gridDirection,
  kw,
  kwh,
  relativeAge,
  degrees,
} from './format.ts';

type Theme = 'light' | 'dark' | 'system';

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme');
    return saved === 'dark' || saved === 'light' ? saved : 'system';
  } catch {
    return 'system';
  }
}

/** Manual zoom, multiplying the fluid root size. The escape hatch for an awkward screen. */
const SCALE_MIN = 0.6;
const SCALE_MAX = 2;
const SCALE_STEP = 0.1;

function readScale(): number {
  try {
    const saved = Number(localStorage.getItem('ui-scale'));
    return Number.isFinite(saved) && saved >= SCALE_MIN && saved <= SCALE_MAX ? saved : 1;
  } catch {
    return 1;
  }
}

export function App() {
  const [payload, setPayload] = useState<SnapshotPayload | null>(null);
  const [series, setSeries] = useState<SeriesPayload | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [showTable, setShowTable] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [scale, setScale] = useState<number>(readScale);
  const [now, setNow] = useState(Date.now());

  // Live snapshots over SSE. One connection, pushed on each poll.
  useEffect(() => subscribe({ onSnapshot: setPayload, onState: setConnection }), []);

  // The chart changes only as fast as the poll, so it is refetched on its own slow timer rather
  // than rebuilt on every push.
  const loadSeries = useCallback(() => {
    fetchSeries(240).then(setSeries, () => undefined);
  }, []);

  useEffect(() => {
    loadSeries();
    const timer = window.setInterval(loadSeries, 120_000);
    return () => window.clearInterval(timer);
  }, [loadSeries]);

  // Drives the "last seen" badge so the age stays honest between pushes.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', String(scale));
    try {
      if (scale === 1) localStorage.removeItem('ui-scale');
      else localStorage.setItem('ui-scale', String(scale));
    } catch {
      /* private mode */
    }
  }, [scale]);

  useEffect(() => {
    const nudge = (delta: number): void =>
      setScale((s) => Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, s + delta)) * 100) / 100);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'd') setShowDiagnostics((open) => !open);
      if (event.key === 'Escape') setShowDiagnostics(false);
      if (event.key === 't') setShowTable((open) => !open);
      // Zoom: '=' is the unshifted '+' on most layouts, so accept both.
      if (event.key === '+' || event.key === '=') nudge(SCALE_STEP);
      if (event.key === '-' || event.key === '_') nudge(-SCALE_STEP);
      if (event.key === '0') setScale(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const snapshot = payload?.snapshot ?? null;
  const timeZone = payload?.server.timeZone ?? 'UTC';
  const totals = payload?.totals ?? null;
  const stale = snapshot?.stale ?? false;

  const grid = snapshot?.gridKw ?? null;
  const battery = snapshot?.batteryKw ?? null;
  const gridWay = gridDirection(grid);
  const batteryWay = batteryDirection(battery);

  const quota = payload?.quota;
  const quotaPct = quota ? Math.round((quota.used / quota.cap) * 100) : 0;

  return (
    // Held at reduced opacity rather than replaced by a skeleton: no flash, no layout jump.
    <div class={`app${payload === null ? ' is-loading' : ''}${stale ? ' is-stale' : ''}`}>
      <header class="bar">
        <div class="bar-title">
          <strong>FoxESS</strong>
          <span class="bar-sep">·</span>
          <span>{payload?.devices[0]?.stationName ?? 'Monitor'}</span>
          {payload?.server.mock && <span class="bar-mock">mock data</span>}
        </div>

        <div class="bar-right">
          {stale ? (
            <span class="bar-status is-stale" title="The inverter has not reported recently">
              <span class="dot" aria-hidden="true" />
              not live · last seen {relativeAge(snapshot?.inverterTimeMs ?? null, now)}
            </span>
          ) : (
            <span class={`bar-status is-${connection}`}>
              <span class="dot" aria-hidden="true" />
              {connection === 'live' ? 'live' : connection === 'connecting' ? 'connecting' : 'reconnecting'}
              {snapshot && <> · {clockTime(snapshot.inverterTimeMs, timeZone)}</>}
            </span>
          )}

          {quota && (
            <span
              class="bar-quota"
              title={`${quota.used} of ${quota.cap} API calls used today`}
              style={{ color: quotaPct > 90 ? 'var(--critical)' : undefined }}
            >
              quota {quota.remaining}
            </span>
          )}

          <button
            class="bar-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle light and dark theme"
            title="Toggle theme"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <main class="grid">
        <section class="panel panel-flow" aria-label="Live energy flow">
          <FlowDiagram snapshot={snapshot} />
        </section>

        <section class="panel panel-side">
          <SocMeter snapshot={snapshot} battery={payload?.battery ?? null} />

          <div class="tiles">
            {/* Magnitude plus a direction word. A leading "+" alongside "discharging" reads as a
                contradiction, and the word is the channel that survives a colourblind reader. */}
            <StatTile label="Solar" value={kw(snapshot?.solarKw)} unit="kW" color="var(--solar)" />
            <StatTile label="Home" value={kw(snapshot?.loadKw)} unit="kW" color="var(--home)" />
            <StatTile
              label="Grid"
              value={kw(grid === null ? null : Math.abs(grid))}
              unit="kW"
              color="var(--grid)"
              note={gridWay === 'idle' ? 'balanced' : gridWay === 'export' ? 'exporting' : 'importing'}
            />
            <StatTile
              label="Battery"
              value={kw(battery === null ? null : Math.abs(battery))}
              unit="kW"
              color="var(--battery)"
              note={batteryWay === 'idle' ? 'resting' : batteryWay}
            />
            <StatTile label="Battery temp" value={degrees(snapshot?.batteryTempC)} unit="°C" />
            <StatTile label="Ambient" value={degrees(snapshot?.ambientTempC)} unit="°C" />
          </div>
        </section>

        <section class="panel panel-totals" aria-label="Today's energy totals">
          <h2 class="panel-title">Today</h2>
          <div class="totals">
            <StatTile label="Solar" value={kwh(totals?.solarKwh)} unit="kWh" color="var(--solar)" />
            <StatTile label="Home" value={kwh(totals?.loadKwh)} unit="kWh" color="var(--home)" />
            <StatTile label="Imported" value={kwh(totals?.importKwh)} unit="kWh" color="var(--grid-import)" />
            <StatTile label="Exported" value={kwh(totals?.exportKwh)} unit="kWh" color="var(--grid-export)" />
            <StatTile label="Charged" value={kwh(totals?.batteryChargedKwh)} unit="kWh" color="var(--battery)" />
            <StatTile label="Discharged" value={kwh(totals?.batteryDischargedKwh)} unit="kWh" color="var(--battery)" />
          </div>
        </section>

        <section class="panel panel-chart" aria-label="Power today">
          <div class="chart-head">
            <h2 class="panel-title">Power today</h2>

            {/* Legend is always present for 2+ series — identity never rests on colour alone. */}
            <div class="legend">
              <span class="legend-item">
                <span class="legend-key" style={{ background: 'var(--solar)' }} /> Solar
              </span>
              <span class="legend-item">
                <span class="legend-key" style={{ background: 'var(--home)' }} /> Home
              </span>
              <span class="legend-item">
                <span class="legend-key" style={{ background: 'var(--battery)' }} /> Battery
              </span>
              <span class="legend-item">
                <span class="legend-key" style={{ background: 'var(--grid-import)' }} /> Import
              </span>
              <span class="legend-item">
                <span class="legend-key" style={{ background: 'var(--grid-export)' }} /> Export
              </span>
            </div>

            <button class="bar-btn" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'chart' : 'table'}
            </button>
          </div>

          {series ? (
            <IntradayChart series={series.series} timeZone={timeZone} showTable={showTable} />
          ) : (
            <div class="chart-empty">Loading today…</div>
          )}
        </section>
      </main>

      {showDiagnostics && <Diagnostics timeZone={timeZone} onClose={() => setShowDiagnostics(false)} />}

      <footer class="hint">
        <kbd>d</kbd> diagnostics · <kbd>t</kbd> table · <kbd>+</kbd>/<kbd>−</kbd> size
        {scale !== 1 && <> ({Math.round(scale * 100)}%)</>}
      </footer>
    </div>
  );
}
