/**
 * Today's power: three categorical series over a signed axis, plus a diverging grid strip below
 * sharing the same time axis.
 *
 * Why grid is a separate diverging strip rather than a fourth line: four all-pairs-distinct hues
 * cannot clear the colour-blindness gates (measured — docs/DECISIONS.md §5), AND grid flow is
 * inherently signed, so import-above / export-below zero is simply the right encoding for it.
 *
 * The main axis INCLUDES NEGATIVES rather than plotting magnitudes. Battery power is signed
 * (positive charging, negative discharging); plotting |value| would draw a discharging battery
 * exactly like a charging one, which is worse than not drawing it at all.
 *
 * Never a dual y-axis. The two plots are separate charts stacked to share a time axis, not two
 * scales overlaid on one plot.
 *
 * Hand-rolled SVG rather than a charting library — the bundle has to stay small for a 4 GB Celeron.
 */

import { useMemo, useState } from 'preact/hooks';
import type { Series } from '../api.ts';
import { kw, clockTime } from '../format.ts';
import { useSize } from '../useSize.ts';

/** Fraction of the plot height given to the diverging grid strip. */
const GRID_SHARE = 0.31;
const PAD_L = 40;
const PAD_R = 52; // room for the import/export pole labels
const PAD_T = 12;
const PAD_B = 8;
const AXIS_BAND = 20; // x-axis labels live below the grid strip

interface SeriesSpec {
  key: 'solarKw' | 'loadKw' | 'batteryKw';
  label: string;
  color: string;
}

const SERIES: SeriesSpec[] = [
  { key: 'solarKw', label: 'Solar', color: 'var(--solar)' },
  { key: 'loadKw', label: 'Home', color: 'var(--home)' },
  { key: 'batteryKw', label: 'Battery', color: 'var(--battery)' },
];

/**
 * Round up to a value a human would put on an axis.
 *
 * The ladder includes 3 and 4 as well as the usual 1/2/2.5/5, because jumping 2.9 straight to 5
 * wastes almost half the plot height on empty space.
 */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const n = value / magnitude;
  return (NICE_STEPS.find((step) => n <= step + 1e-9) ?? 10) * magnitude;
}

/**
 * Ticks at one uniform step across [min, max], always including zero.
 *
 * A naive {max, max/2, 0, min/2, min} crowds the labels together whenever the negative arm is much
 * shorter than the positive one — which is the normal case here, since solar peaks around 4 kW
 * while the battery only dips a few hundred watts below zero.
 */
function ticksFor(min: number, max: number, targetCount = 4): number[] {
  const span = max - min;
  if (span <= 0) return [0];

  const rough = span / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = (NICE_STEPS.find((s) => rough / magnitude <= s + 1e-9) ?? 10) * magnitude;

  const out: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value += step) {
    // Kill floating-point dust like 0.30000000000000004.
    out.push(Number(value.toFixed(6)));
  }
  if (!out.some((v) => Math.abs(v) < 1e-9)) out.push(0);
  return out.sort((a, b) => b - a);
}

/**
 * Build an SVG path, breaking wherever the data is null.
 *
 * Nulls are real outages (the server inserts them for gaps over 10 minutes), so the line must break
 * rather than draw across hours the inverter was offline.
 */
function linePath(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let path = '';
  let penDown = false;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null || value === undefined || !Number.isFinite(value)) {
      penDown = false;
      continue;
    }
    path += `${penDown ? 'L' : 'M'}${x(i).toFixed(1)} ${y(value).toFixed(1)}`;
    penDown = true;
  }
  return path;
}

export function IntradayChart({
  series,
  timeZone,
  showTable,
}: {
  series: Series;
  timeZone: string;
  showTable: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn in real pixels, so text and strokes are never distorted by non-uniform scaling.
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const n = series.t.length;

  const scales = useMemo(() => {
    const values = SERIES.flatMap((s) =>
      series[s.key].filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
    );
    // Zero is always on the axis, so a signed series reads against a real baseline.
    const maxPower = niceMax(Math.max(0.5, ...values));
    const lowest = Math.min(0, ...values);
    const minPower = lowest < 0 ? -niceMax(Math.abs(lowest)) : 0;

    const gridValues = series.gridKw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const maxGrid = niceMax(Math.max(0.5, ...gridValues.map(Math.abs)));

    return { maxPower, minPower, maxGrid };
  }, [series]);

  if (showTable) {
    return <ChartTable series={series} timeZone={timeZone} />;
  }
  if (n === 0) {
    return <div class="chart-empty">No samples for today yet.</div>;
  }

  const W = Math.max(320, size.width);
  const H = Math.max(160, size.height);
  const H_GRID = Math.round(H * GRID_SHARE);
  const H_MAIN = H - H_GRID;

  const plotW = W - PAD_L - PAD_R;
  const x = (i: number): number => PAD_L + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  const mainPlotH = H_MAIN - PAD_T - PAD_B;
  const span = scales.maxPower - scales.minPower;
  const yPower = (v: number): number => PAD_T + ((scales.maxPower - v) / span) * mainPlotH;

  const gridPlotH = H_GRID - PAD_T - AXIS_BAND;
  const gridZero = PAD_T + gridPlotH / 2;
  const yGrid = (v: number): number => gridZero - (v / scales.maxGrid) * (gridPlotH / 2);

  // Three-hourly ticks, so labels never collide at 1366px.
  const ticks: { i: number; label: string }[] = [];
  let lastHour = -1;
  for (let i = 0; i < n; i++) {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(
        new Date(series.t[i]!),
      ),
    );
    if (hour !== lastHour && hour % 3 === 0) {
      ticks.push({ i, label: clockTime(series.t[i]!, timeZone) });
      lastHour = hour;
    }
  }

  return (
    <div class="chart-wrap" ref={wrapRef}>
      <svg
        class="chart"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Solar, home and battery power today, with grid import and export"
        onMouseMove={(event) => {
          const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((event.clientX - rect.left) / rect.width) * W;
          const index = Math.round(((px - PAD_L) / plotW) * (n - 1));
          setHover(index >= 0 && index < n ? index : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {/* ── power plot ─────────────────────────────────────────────────── */}
        {ticksFor(scales.minPower, scales.maxPower).map((value) => (
          <g key={`pg-${value}`}>
            <line
              class={value === 0 ? 'chart-axis' : 'chart-grid'}
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yPower(value)}
              y2={yPower(value)}
            />
            <text class="chart-tick" x={PAD_L - 6} y={yPower(value) + 3} text-anchor="end">
              {value}
            </text>
          </g>
        ))}
        {SERIES.map((spec) => (
          <path
            key={spec.key}
            class="chart-line"
            d={linePath(series[spec.key], x, yPower)}
            style={{ stroke: spec.color }}
          />
        ))}

        {/* ── grid strip: diverging around a neutral zero ─────────────────── */}
        <g transform={`translate(0 ${H_MAIN})`}>
          <line class="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={yGrid(scales.maxGrid)} y2={yGrid(scales.maxGrid)} />
          <line class="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={yGrid(-scales.maxGrid)} y2={yGrid(-scales.maxGrid)} />

          <text class="chart-tick" x={PAD_L - 6} y={yGrid(scales.maxGrid) + 9} text-anchor="end">
            {scales.maxGrid}
          </text>
          <text class="chart-tick" x={PAD_L - 6} y={yGrid(-scales.maxGrid) - 1} text-anchor="end">
            {scales.maxGrid}
          </text>

          {series.gridKw.map((value, i) => {
            if (value === null || !Number.isFinite(value) || Math.abs(value) < 0.005) return null;
            // A 2px surface gap between neighbours: white does the separating, not a stroke.
            const barW = Math.max(1, plotW / n - 2);
            const height = Math.max(1, Math.abs(yGrid(value) - gridZero));
            return (
              <rect
                key={`grid-${i}`}
                x={x(i) - barW / 2}
                y={value > 0 ? yGrid(value) : gridZero}
                width={barW}
                height={height}
                fill={value > 0 ? 'var(--grid-import)' : 'var(--grid-export)'}
              />
            );
          })}

          {/* The midpoint of a diverging scale must read as "nothing". */}
          <line class="chart-axis" x1={PAD_L} x2={W - PAD_R} y1={gridZero} y2={gridZero} />

          {/* Words, so import/export never rests on hue alone. */}
          <text class="chart-pole" x={W - PAD_R + 6} y={yGrid(scales.maxGrid / 2) + 3}>
            import
          </text>
          <text class="chart-pole" x={W - PAD_R + 6} y={yGrid(-scales.maxGrid / 2) + 3}>
            export
          </text>

          {ticks.map((tick) => (
            <text
              key={`t-${tick.i}`}
              class="chart-tick"
              x={x(tick.i)}
              y={H_GRID - 5}
              text-anchor="middle"
            >
              {tick.label}
            </text>
          ))}
        </g>

        {hover !== null && (
          <line
            class="chart-crosshair"
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD_T}
            y2={H - AXIS_BAND}
          />
        )}
      </svg>

      {hover !== null && (
        <Tooltip series={series} index={hover} timeZone={timeZone} leftPct={(x(hover) / W) * 100} />
      )}
    </div>
  );
}

function Tooltip({
  series,
  index,
  timeZone,
  leftPct,
}: {
  series: Series;
  index: number;
  timeZone: string;
  leftPct: number;
}) {
  const at = (values: (number | null)[]): number | null => values[index] ?? null;

  const battery = at(series.batteryKw);
  const grid = at(series.gridKw);
  const soc = at(series.soc);

  /** Direction as a word, so the tooltip never leans on the sign alone. */
  const way = (value: number | null, positive: string, negative: string): string =>
    value === null || Math.abs(value) < 0.005 ? '' : value > 0 ? ` ${positive}` : ` ${negative}`;

  const rows = [
    { label: 'Solar', color: 'var(--solar)', value: at(series.solarKw), suffix: '' },
    { label: 'Home', color: 'var(--home)', value: at(series.loadKw), suffix: '' },
    {
      label: 'Battery',
      color: 'var(--battery)',
      value: battery === null ? null : Math.abs(battery),
      suffix: way(battery, 'charging', 'discharging'),
    },
    {
      label: 'Grid',
      color: (grid ?? 0) < 0 ? 'var(--grid-export)' : 'var(--grid-import)',
      value: grid === null ? null : Math.abs(grid),
      suffix: way(grid, 'import', 'export'),
    },
  ];

  return (
    <div
      class="chart-tooltip"
      style={{ left: `${leftPct}%`, transform: `translateX(${leftPct > 65 ? '-105%' : '5%'})` }}
    >
      <div class="chart-tooltip-time">{clockTime(series.t[index]!, timeZone)}</div>
      {rows.map((row) => (
        <div key={row.label} class="chart-tooltip-row">
          <span class="chart-tooltip-dot" style={{ background: row.color }} />
          <span class="chart-tooltip-label">{row.label}</span>
          <span class="chart-tooltip-value">
            {kw(row.value)} kW
            <span class="chart-tooltip-suffix">{row.suffix}</span>
          </span>
        </div>
      ))}
      <div class="chart-tooltip-row">
        <span class="chart-tooltip-dot is-hollow" />
        <span class="chart-tooltip-label">Battery charge</span>
        <span class="chart-tooltip-value">{soc === null ? '—' : `${Math.round(soc)} %`}</span>
      </div>
    </div>
  );
}

/**
 * The table twin.
 *
 * A tooltip must never be the only way to read a value: hover is unavailable on a touch screen, to
 * a keyboard user, and to a screen reader. Thinned to roughly 60 rows so it stays scannable.
 */
function ChartTable({ series, timeZone }: { series: Series; timeZone: string }) {
  const step = Math.max(1, Math.ceil(series.t.length / 60));
  const rows: number[] = [];
  for (let i = 0; i < series.t.length; i += step) rows.push(i);

  const signed = (value: number | null, positive: string, negative: string): string => {
    if (value === null || !Number.isFinite(value)) return '—';
    if (Math.abs(value) < 0.005) return '0.00';
    return `${kw(value)} ${value > 0 ? positive : negative}`;
  };

  return (
    <div class="chart-table-wrap">
      <table class="chart-table">
        <caption class="visually-hidden">Power readings today</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Solar kW</th>
            <th scope="col">Home kW</th>
            <th scope="col">Battery kW</th>
            <th scope="col">Grid kW</th>
            <th scope="col">SOC %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i}>
              <td>{clockTime(series.t[i]!, timeZone)}</td>
              <td>{kw(series.solarKw[i])}</td>
              <td>{kw(series.loadKw[i])}</td>
              <td>{signed(series.batteryKw[i] ?? null, 'charging', 'discharging')}</td>
              <td>{signed(series.gridKw[i] ?? null, 'import', 'export')}</td>
              <td>{series.soc[i] === null ? '—' : Math.round(series.soc[i]!)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
