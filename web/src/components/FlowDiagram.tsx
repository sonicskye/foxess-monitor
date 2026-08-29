/**
 * The energy flow diagram.
 *
 * Solar sits at the top; home, battery and grid below it. Each edge shows where power is going and
 * how much.
 *
 * Direction is carried by THREE independent channels, so no single one is load-bearing:
 *   1. an arrowhead pointing the way the energy travels,
 *   2. a numeric kW label,
 *   3. a dash animation whose speed scales with power.
 *
 * The animation is pure CSS (`stroke-dashoffset`), never a requestAnimationFrame loop — this runs
 * for months on a Celeron, and a JS animation loop would keep a core busy forever. Under
 * `prefers-reduced-motion` the animation stops entirely and the arrowhead plus label still say
 * everything.
 */

import type { Snapshot } from '../api.ts';
import { kw } from '../format.ts';

const IDLE_KW = 0.01;

interface Edge {
  id: string;
  /** SVG path from source to destination. */
  d: string;
  /** kW along the edge; always positive. Zero means idle. */
  power: number;
  color: string;
  /** Where to put the number. */
  labelX: number;
  labelY: number;
  /** Reversed means the visual path is drawn against the flow direction. */
  reverse: boolean;
  title: string;
}

function Node({
  x,
  y,
  label,
  value,
  unit,
  color,
  icon,
  dim,
}: {
  x: number;
  y: number;
  label: string;
  value: string;
  unit: string;
  color: string;
  icon: string;
  dim?: boolean;
}) {
  return (
    <g class={`flow-node${dim ? ' is-dim' : ''}`} transform={`translate(${x} ${y})`}>
      <circle r="46" class="flow-node-bg" style={{ stroke: color }} />
      <text class="flow-node-icon" y="-20" text-anchor="middle">
        {icon}
      </text>
      <text class="flow-node-value" y="6" text-anchor="middle">
        {value}
      </text>
      <text class="flow-node-unit" y="22" text-anchor="middle">
        {unit}
      </text>
      <text class="flow-node-label" y="66" text-anchor="middle">
        {label}
      </text>
    </g>
  );
}

export function FlowDiagram({ snapshot }: { snapshot: Snapshot | null }) {
  const solar = snapshot?.solarKw ?? null;
  const load = snapshot?.loadKw ?? null;
  const grid = snapshot?.gridKw ?? null;
  const battery = snapshot?.batteryKw ?? null;

  // Node centres on a 560x300 canvas. Landscape rather than square so the diagram fills a wide
  // panel instead of letterboxing into the middle third of it.
  const SOLAR = { x: 280, y: 56 };
  const HOME = { x: 280, y: 232 };
  const BATTERY = { x: 74, y: 144 };
  const GRID = { x: 486, y: 144 };

  const edges: Edge[] = [
    {
      id: 'solar-home',
      d: `M ${SOLAR.x} ${SOLAR.y + 48} L ${HOME.x} ${HOME.y - 48}`,
      power: Math.max(0, solar ?? 0),
      color: 'var(--solar)',
      labelX: SOLAR.x + 48,
      labelY: 148,
      reverse: false,
      title: 'Solar to home',
    },
    {
      id: 'battery',
      // Drawn battery → home. Charging reverses it.
      d: `M ${BATTERY.x + 40} ${BATTERY.y + 26} Q ${BATTERY.x + 60} ${HOME.y} ${HOME.x - 48} ${HOME.y - 6}`,
      power: Math.abs(battery ?? 0),
      color: 'var(--battery)',
      labelX: 152,
      labelY: 226,
      reverse: (battery ?? 0) > 0, // charging: home side → battery
      title: (battery ?? 0) > 0 ? 'Charging battery' : 'Battery to home',
    },
    {
      id: 'grid',
      // Drawn grid → home. Exporting reverses it.
      d: `M ${GRID.x - 40} ${GRID.y + 26} Q ${GRID.x - 60} ${HOME.y} ${HOME.x + 48} ${HOME.y - 6}`,
      power: Math.abs(grid ?? 0),
      color: (grid ?? 0) < 0 ? 'var(--grid-export)' : 'var(--grid-import)',
      labelX: 408,
      labelY: 226,
      reverse: (grid ?? 0) < 0, // exporting: home side → grid
      title: (grid ?? 0) < 0 ? 'Exporting to grid' : 'Importing from grid',
    },
  ];

  return (
    <svg
      class="flow"
      viewBox="0 0 560 300"
      role="img"
      aria-label="Energy flow between solar, home, battery and grid"
    >
      <defs>
        {edges.map((edge) => (
          <marker
            key={edge.id}
            id={`arrow-${edge.id}`}
            viewBox="0 0 10 10"
            refX="8"
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
        const idle = edge.power < IDLE_KW;
        // Faster flow for more power, clamped so a 5 kW surge is not a blur.
        const duration = idle ? 0 : Math.max(0.5, 3 - Math.min(edge.power, 5) * 0.45);

        return (
          <g key={edge.id} class={idle ? 'flow-edge is-idle' : 'flow-edge'}>
            <title>{`${edge.title}: ${kw(edge.power)} kW`}</title>
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
        edge.power < IDLE_KW ? null : (
          <text key={`${edge.id}-label`} class="flow-edge-label" x={edge.labelX} y={edge.labelY}>
            {kw(edge.power)} kW
          </text>
        ),
      )}

      <Node
        {...SOLAR}
        icon="☀"
        label="Solar"
        value={kw(solar)}
        unit="kW"
        color="var(--solar)"
        dim={(solar ?? 0) < IDLE_KW}
      />
      <Node {...HOME} icon="⌂" label="Home" value={kw(load)} unit="kW" color="var(--home)" />
      <Node
        {...BATTERY}
        icon="▭"
        label="Battery"
        value={kw(battery)}
        unit="kW"
        color="var(--battery)"
        dim={Math.abs(battery ?? 0) < IDLE_KW}
      />
      <Node
        {...GRID}
        icon="⌁"
        label="Grid"
        value={kw(grid)}
        unit="kW"
        color={(grid ?? 0) < 0 ? 'var(--grid-export)' : 'var(--grid-import)'}
        dim={Math.abs(grid ?? 0) < IDLE_KW}
      />
    </svg>
  );
}
