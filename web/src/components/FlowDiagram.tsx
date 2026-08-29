/**
 * The energy flow diagram.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE INVERTER IS THE HUB — this is not a stylistic choice
 * ─────────────────────────────────────────────────────────────────────────────
 * In a FoxESS hybrid system, PV, the battery and the grid all connect to the INVERTER, and the
 * house loads hang off it. The house has no direct connection to the grid.
 *
 * An earlier version drew solar→home, battery↔home and grid↔home, making Home the hub. It looked
 * plausible and was wrong: it showed the house exporting to the grid, which never happens. If you
 * are tempted to "simplify" this back to three edges, read docs/DECISIONS.md §7 first.
 *
 *      Solar ──►┐
 *               │
 *   Battery ◄──►├─ INVERTER ──► Home
 *               │
 *      Grid ◄──►┘
 *
 * Direction is carried by THREE independent channels, so none is load-bearing alone:
 *   1. an arrowhead pointing the way the energy travels,
 *   2. a numeric kW value and a status word ("charging", "exporting"),
 *   3. a dash animation whose speed scales with power.
 *
 * The animation is pure CSS (`stroke-dashoffset`), never a requestAnimationFrame loop — this runs
 * for months on a Celeron. Under `prefers-reduced-motion` it stops entirely, and the arrowhead plus
 * the words still say everything.
 *
 * The four flows are NOT reconciled. At the inverter, in (solar + discharge + import) should
 * roughly equal out (load + charge + export), but conversion losses and per-variable measurement
 * timing mean it will not tie exactly. These are measured values, not a solved balance.
 */

import type { JSX } from 'preact';
import type { Snapshot } from '../api.ts';
import { batteryDirection, gridDirection, kw, runningStateLabel } from '../format.ts';
import { AlertIcon, BatteryIcon, GridIcon, HomeIcon, InverterIcon, SolarIcon } from './Icons.tsx';

/** Below this, a flow is idle: the edge greys out and loses its arrow and number. */
const IDLE_KW = 0.01;

/*
 * Canvas aspect (2.2) is matched to the panel it sits in (~650x292) so the diagram fills the space
 * instead of letterboxing. A cross needs vertical room, so the arms are deliberately asymmetric:
 * short vertical ones to solar and battery, long horizontal ones to grid and home, which is where
 * the spare width is.
 */
const W = 660;
const H = 300;

const CARD_W = 146;
/** Solar and home need no status line, so their cards are shorter. */
const CARD_H = 74;
const PLAIN_H = 62;
/** The hub is larger, so it reads as the centre of the system rather than a fifth peer. */
const HUB_W = 154;
const HUB_H = 82;

const HUB = { x: W / 2, y: H / 2 };
const SOLAR = { x: W / 2, y: 38 };
const BATTERY = { x: W / 2, y: H - 40 };
const GRID = { x: 84, y: H / 2 };
const HOME = { x: W - 84, y: H / 2 };

interface NodeSpec {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NODES: Record<string, NodeSpec> = {
  hub: { ...HUB, w: HUB_W, h: HUB_H },
  solar: { ...SOLAR, w: CARD_W, h: PLAIN_H },
  battery: { ...BATTERY, w: CARD_W, h: CARD_H },
  grid: { ...GRID, w: CARD_W, h: CARD_H },
  home: { ...HOME, w: CARD_W, h: PLAIN_H },
};

function Card({
  node,
  icon,
  label,
  value,
  unit,
  status,
  statusClass,
  color,
  dim,
  hub,
  alert,
}: {
  node: NodeSpec;
  icon: JSX.Element;
  label: string;
  value: string;
  unit: string;
  status?: string;
  statusClass?: string;
  color: string;
  dim?: boolean;
  hub?: boolean;
  alert?: boolean;
}) {
  const left = node.x - node.w / 2;
  const top = node.y - node.h / 2;

  return (
    <g
      class={`flow-card${dim ? ' is-dim' : ''}${hub ? ' is-hub' : ''}${alert ? ' is-alert' : ''}`}
      // Resolved here rather than in CSS: an inline `color` would beat a `.is-dim` class rule,
      // which is exactly the bug that left idle cards at full strength.
      style={{ color: alert ? 'var(--critical)' : dim ? 'var(--axis)' : color }}
      transform={`translate(${left} ${top})`}
    >
      <rect class="flow-card-bg" x="0" y="0" width={node.w} height={node.h} rx="10" />

      <g transform={`translate(22 ${status ? 20 : 22})`}>{icon}</g>

      <text class="flow-card-label" x="38" y={status ? 25 : 27}>
        {label}
      </text>

      <text class="flow-card-value" x="15" y={status ? 51 : 52}>
        {value}
        <tspan class="flow-card-unit" dx="4">
          {unit}
        </tspan>
      </text>

      {status && (
        <text class={`flow-card-status ${statusClass ?? ''}`} x="15" y="66">
          {status}
        </text>
      )}
    </g>
  );
}

interface Edge {
  id: string;
  d: string;
  /** Always positive. Below IDLE_KW the edge is drawn as idle. */
  power: number;
  color: string;
  /** True when energy travels against the direction the path is drawn in. */
  reverse: boolean;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'middle' | 'end';
  /** Spoken description, used for the tooltip and the diagram's aria-label. */
  description: string;
  /** Null power means "this inverter has no such connection" — drawn as absent, not as zero. */
  absent: boolean;
}

export function FlowDiagram({ snapshot }: { snapshot: Snapshot | null }) {
  const solar = snapshot?.solarKw ?? null;
  const load = snapshot?.loadKw ?? null;
  const grid = snapshot?.gridKw ?? null;
  const battery = snapshot?.batteryKw ?? null;
  const acOutput = snapshot?.generationKw ?? null;
  const soc = snapshot?.soc ?? null;

  const gridWay = gridDirection(grid);
  const batteryWay = batteryDirection(battery);
  const state = runningStateLabel(snapshot?.runningState);

  // Gaps between a card edge and the arrow, so the arrowhead never touches the card.
  const GAP = 7;
  const hubTop = HUB.y - HUB_H / 2;
  const hubBottom = HUB.y + HUB_H / 2;
  const hubLeft = HUB.x - HUB_W / 2;
  const hubRight = HUB.x + HUB_W / 2;

  const edges: Edge[] = [
    {
      id: 'solar',
      // Solar → inverter. PV only ever produces, so this never reverses.
      d: `M ${SOLAR.x} ${SOLAR.y + PLAIN_H / 2 + GAP} L ${SOLAR.x} ${hubTop - GAP}`,
      power: Math.max(0, solar ?? 0),
      color: 'var(--solar)',
      reverse: false,
      labelX: SOLAR.x + 12,
      labelY: (SOLAR.y + PLAIN_H / 2 + hubTop) / 2 + 4,
      anchor: 'start',
      description:
        (solar ?? 0) >= IDLE_KW ? `solar producing ${kw(solar)} kilowatts` : 'solar not producing',
      absent: solar === null,
    },
    {
      id: 'battery',
      // Drawn inverter → battery, i.e. the charging direction. Discharging reverses it.
      d: `M ${BATTERY.x} ${hubBottom + GAP} L ${BATTERY.x} ${BATTERY.y - CARD_H / 2 - GAP}`,
      power: Math.abs(battery ?? 0),
      color: 'var(--battery)',
      reverse: batteryWay === 'discharging',
      labelX: BATTERY.x + 12,
      labelY: (hubBottom + BATTERY.y - CARD_H / 2) / 2 + 4,
      anchor: 'start',
      description:
        batteryWay === 'idle'
          ? 'battery idle'
          : `battery ${batteryWay} at ${kw(Math.abs(battery ?? 0))} kilowatts`,
      absent: battery === null,
    },
    {
      id: 'grid',
      // Drawn grid → inverter, i.e. the importing direction. Exporting reverses it.
      d: `M ${GRID.x + CARD_W / 2 + GAP} ${GRID.y} L ${hubLeft - GAP} ${GRID.y}`,
      power: Math.abs(grid ?? 0),
      // Identity, not state: a node must not repaint as power changes direction. The arrowhead and
      // the "importing"/"exporting" word carry direction. See docs/DECISIONS.md §8.
      color: 'var(--grid)',
      reverse: gridWay === 'export',
      labelX: (GRID.x + CARD_W / 2 + hubLeft) / 2,
      labelY: GRID.y - 12,
      anchor: 'middle',
      description:
        gridWay === 'idle'
          ? 'grid balanced'
          : `${gridWay === 'export' ? 'exporting' : 'importing'} ${kw(Math.abs(grid ?? 0))} kilowatts`,
      absent: grid === null,
    },
    {
      id: 'home',
      // Inverter → home. Loads only ever consume, so this never reverses.
      d: `M ${hubRight + GAP} ${HOME.y} L ${HOME.x - CARD_W / 2 - GAP} ${HOME.y}`,
      power: Math.max(0, load ?? 0),
      color: 'var(--home)',
      reverse: false,
      labelX: (hubRight + HOME.x - CARD_W / 2) / 2,
      labelY: HOME.y - 12,
      anchor: 'middle',
      description: `home using ${kw(load)} kilowatts`,
      absent: load === null,
    },
  ];

  // Spoken from live values, so a screen reader gets the same information as the picture.
  const summary = edges
    .filter((edge) => !edge.absent)
    .map((edge) => edge.description)
    .join('; ');

  return (
    <svg class="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Energy flow: ${summary}`}>
      <defs>
        {edges.map((edge) => (
          <marker
            key={edge.id}
            id={`arrow-${edge.id}`}
            viewBox="0 0 10 10"
            refX="7"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" fill={edge.color} />
          </marker>
        ))}
      </defs>

      {edges.map((edge) => {
        if (edge.absent) return null;
        const idle = edge.power < IDLE_KW;
        // Faster for more power, floored so a 5 kW surge is not a blur.
        const duration = Math.max(0.5, 3 - Math.min(edge.power, 5) * 0.45);

        return (
          <g key={edge.id} class={idle ? 'flow-edge is-idle' : 'flow-edge'}>
            <title>{edge.description}</title>
            <path
              class="flow-edge-track"
              d={edge.d}
              style={{ stroke: idle ? 'var(--gridline)' : edge.color }}
            />
            {!idle && (
              <path
                class="flow-edge-dash"
                d={edge.d}
                style={{
                  stroke: edge.color,
                  animationDuration: `${duration}s`,
                  animationDirection: edge.reverse ? 'reverse' : 'normal',
                }}
                marker-end={edge.reverse ? undefined : `url(#arrow-${edge.id})`}
                marker-start={edge.reverse ? `url(#arrow-${edge.id})` : undefined}
              />
            )}
          </g>
        );
      })}

      {edges.map((edge) =>
        edge.absent || edge.power < IDLE_KW ? null : (
          <text
            key={`${edge.id}-label`}
            class="flow-edge-label"
            x={edge.labelX}
            y={edge.labelY}
            text-anchor={edge.anchor}
          >
            {kw(edge.power)} kW
          </text>
        ),
      )}

      <Card
        node={NODES['solar']!}
        icon={<SolarIcon size={22} />}
        label="Solar"
        value={kw(solar)}
        unit="kW"
        color="var(--solar)"
        dim={(solar ?? 0) < IDLE_KW}
      />

      <Card
        node={NODES['grid']!}
        icon={<GridIcon size={22} />}
        label="Grid"
        value={kw(grid === null ? null : Math.abs(grid))}
        unit="kW"
        status={gridWay === 'idle' ? 'balanced' : gridWay === 'export' ? 'exporting' : 'importing'}
        color="var(--grid)"
        dim={Math.abs(grid ?? 0) < IDLE_KW}
      />

      <Card
        node={NODES['hub']!}
        hub
        // A fault outlines the whole card, so it is visible from across the room — which is the
        // point of a wall display.
        alert={state?.severity === 'fault'}
        icon={state?.severity === 'fault' ? <AlertIcon size={23} /> : <InverterIcon size={23} />}
        label="Inverter"
        value={kw(acOutput)}
        unit="kW"
        // A fault state gets the reserved colour AND the warning icon AND the word — never colour alone.
        status={state?.label ?? 'no status'}
        statusClass={state ? `is-${state.severity}` : undefined}
        color="var(--text-secondary)"
      />

      <Card
        node={NODES['home']!}
        icon={<HomeIcon size={22} />}
        label="Home"
        value={kw(load)}
        unit="kW"
        color="var(--home)"
      />

      <Card
        node={NODES['battery']!}
        icon={<BatteryIcon size={22} soc={soc} />}
        label="Battery"
        value={kw(battery === null ? null : Math.abs(battery))}
        unit="kW"
        status={battery === null ? 'not fitted' : batteryWay === 'idle' ? 'idle' : batteryWay}
        color="var(--battery)"
        dim={Math.abs(battery ?? 0) < IDLE_KW}
      />
    </svg>
  );
}
