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
import { useSize } from '../useSize.ts';
import { AlertIcon, BatteryIcon, GridIcon, HomeIcon, InverterIcon, SolarIcon } from './Icons.tsx';

/** Below this, a flow is idle: the edge greys out and loses its arrow and number. */
const IDLE_KW = 0.01;

interface NodeSpec {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Geometry {
  w: number;
  h: number;
  nodes: Record<'hub' | 'solar' | 'battery' | 'grid' | 'home', NodeSpec>;
  portrait: boolean;
}

/*
 * WIDE: a cross, aspect 2.2 to match the desktop panel (~650x292) so the diagram fills it instead
 * of letterboxing. The arms are deliberately asymmetric — short vertical ones to solar and battery,
 * long horizontal ones to grid and home, which is where the spare width is.
 */
const WIDE: Geometry = {
  w: 660,
  h: 300,
  portrait: false,
  nodes: {
    hub: { x: 330, y: 150, w: 154, h: 82 },
    // Solar and home need no status line, so their cards are shorter.
    solar: { x: 330, y: 38, w: 146, h: 62 },
    battery: { x: 330, y: 260, w: 146, h: 74 },
    grid: { x: 84, y: 150, w: 146, h: 74 },
    home: { x: 576, y: 150, w: 146, h: 62 },
  },
};

/*
 * NARROW: a diamond, for phones and portrait tablets.
 *
 * The cross does not survive a 390px width — grid, hub and home side by side need well over 400px
 * before the arms have room for an arrowhead. So grid and home drop to their own row below the hub
 * and the arms become diagonal, and the battery sits below, its edge running down the clear channel
 * between them. Same four edges, same directions; only the coordinates change.
 */
const NARROW: Geometry = {
  w: 380,
  h: 500,
  portrait: true,
  nodes: {
    solar: { x: 190, y: 38, w: 172, h: 62 },
    hub: { x: 190, y: 156, w: 176, h: 80 },
    // Grid and home leave a clear channel between them (163..217) for the battery edge to run down.
    grid: { x: 86, y: 292, w: 146, h: 74 },
    home: { x: 294, y: 292, w: 146, h: 62 },
    battery: { x: 190, y: 428, w: 172, h: 74 },
  },
};

/** Below this width-to-height ratio the cross stops working; see NARROW. */
const PORTRAIT_ASPECT = 1.45;

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
  // Measured so the layout can switch shape; the SVG itself still scales via its viewBox.
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const geo = size.width > 0 && size.width / Math.max(1, size.height) < PORTRAIT_ASPECT ? NARROW : WIDE;
  const { nodes: NODES, w: W, h: H } = geo;
  const { hub: HUB, solar: SOLAR, battery: BATTERY, grid: GRID, home: HOME } = NODES;

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
  const hubTop = HUB.y - HUB.h / 2;
  const hubBottom = HUB.y + HUB.h / 2;
  const hubLeft = HUB.x - HUB.w / 2;
  const hubRight = HUB.x + HUB.w / 2;

  /*
   * In portrait, grid and home hang below the hub rather than beside it, so their edges run
   * diagonally from the hub's lower corners to the top of each card. The battery edge then drops
   * straight down the clear channel between them.
   */
  const gridEdge = geo.portrait
    ? `M ${GRID.x} ${GRID.y - GRID.h / 2 - GAP} L ${hubLeft + 18} ${hubBottom + GAP}`
    : `M ${GRID.x + GRID.w / 2 + GAP} ${GRID.y} L ${hubLeft - GAP} ${GRID.y}`;

  const homeEdge = geo.portrait
    ? `M ${hubRight - 18} ${hubBottom + GAP} L ${HOME.x} ${HOME.y - HOME.h / 2 - GAP}`
    : `M ${hubRight + GAP} ${HOME.y} L ${HOME.x - HOME.w / 2 - GAP} ${HOME.y}`;

  const edges: Edge[] = [
    {
      id: 'solar',
      // Solar → inverter. PV only ever produces, so this never reverses.
      d: `M ${SOLAR.x} ${SOLAR.y + SOLAR.h / 2 + GAP} L ${SOLAR.x} ${hubTop - GAP}`,
      power: Math.max(0, solar ?? 0),
      color: 'var(--solar)',
      reverse: false,
      labelX: SOLAR.x + 12,
      labelY: (SOLAR.y + SOLAR.h / 2 + hubTop) / 2 + 4,
      anchor: 'start',
      description:
        (solar ?? 0) >= IDLE_KW ? `solar producing ${kw(solar)} kilowatts` : 'solar not producing',
      absent: solar === null,
    },
    {
      id: 'battery',
      // Drawn inverter → battery, i.e. the charging direction. Discharging reverses it.
      d: `M ${BATTERY.x} ${hubBottom + GAP} L ${BATTERY.x} ${BATTERY.y - BATTERY.h / 2 - GAP}`,
      power: Math.abs(battery ?? 0),
      color: 'var(--battery)',
      reverse: batteryWay === 'discharging',
      labelX: BATTERY.x + 12,
      labelY: (hubBottom + BATTERY.y - BATTERY.h / 2) / 2 + 4,
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
      d: gridEdge,
      power: Math.abs(grid ?? 0),
      // Identity, not state: a node must not repaint as power changes direction. The arrowhead and
      // the "importing"/"exporting" word carry direction. See docs/DECISIONS.md §8.
      color: 'var(--grid)',
      reverse: gridWay === 'export',
      labelX: geo.portrait ? GRID.x - 4 : (GRID.x + GRID.w / 2 + hubLeft) / 2,
      labelY: geo.portrait ? (hubBottom + GRID.y - GRID.h / 2) / 2 + 4 : GRID.y - 12,
      anchor: geo.portrait ? 'end' : 'middle',
      description:
        gridWay === 'idle'
          ? 'grid balanced'
          : `${gridWay === 'export' ? 'exporting' : 'importing'} ${kw(Math.abs(grid ?? 0))} kilowatts`,
      absent: grid === null,
    },
    {
      id: 'home',
      // Inverter → home. Loads only ever consume, so this never reverses.
      d: homeEdge,
      power: Math.max(0, load ?? 0),
      color: 'var(--home)',
      reverse: false,
      labelX: geo.portrait ? HOME.x + 4 : (hubRight + HOME.x - HOME.w / 2) / 2,
      labelY: geo.portrait ? (hubBottom + HOME.y - HOME.h / 2) / 2 + 4 : HOME.y - 12,
      anchor: geo.portrait ? 'start' : 'middle',
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
    <div class="flow-wrap" ref={wrapRef}>
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
        node={SOLAR}
        icon={<SolarIcon size={22} />}
        label="Solar"
        value={kw(solar)}
        unit="kW"
        color="var(--solar)"
        dim={(solar ?? 0) < IDLE_KW}
      />

      <Card
        node={GRID}
        icon={<GridIcon size={22} />}
        label="Grid"
        value={kw(grid === null ? null : Math.abs(grid))}
        unit="kW"
        status={gridWay === 'idle' ? 'balanced' : gridWay === 'export' ? 'exporting' : 'importing'}
        color="var(--grid)"
        dim={Math.abs(grid ?? 0) < IDLE_KW}
      />

      <Card
        node={HUB}
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
        node={HOME}
        icon={<HomeIcon size={22} />}
        label="Home"
        value={kw(load)}
        unit="kW"
        color="var(--home)"
      />

      <Card
        node={BATTERY}
        icon={<BatteryIcon size={22} soc={soc} />}
        label="Battery"
        value={kw(battery === null ? null : Math.abs(battery))}
        unit="kW"
        status={battery === null ? 'not fitted' : batteryWay === 'idle' ? 'idle' : batteryWay}
        color="var(--battery)"
        dim={Math.abs(battery ?? 0) < IDLE_KW}
      />
      </svg>
    </div>
  );
}
