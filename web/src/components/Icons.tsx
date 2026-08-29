/**
 * Drawn symbols for the flow diagram.
 *
 * SVG paths rather than emoji or box-drawing characters. A glyph like `▭` depends on whatever font
 * the machine happens to have — on a minimal kiosk install it may render as a tofu box, it cannot
 * inherit the theme, and it looks different on every platform. These are stroked in `currentColor`,
 * so a node dims or changes colour just by setting `color` on its group.
 *
 * All icons draw inside a 24×24 box centred on the origin, scaled by `size`.
 */

interface IconProps {
  /** Rendered width and height in user units. */
  size?: number;
}

function box(size: number): { transform: string } {
  // Draw in a 24-unit box centred on (0,0).
  const scale = size / 24;
  return { transform: `scale(${scale}) translate(-12 -12)` };
}

/** Photovoltaic panel with a sun above it. */
export function SolarIcon({ size = 24 }: IconProps) {
  return (
    <g class="icon" {...box(size)}>
      {/* sun */}
      <circle cx="12" cy="5" r="2.6" />
      <path d="M12 0.4v1.4M12 8.2v1.4M6.8 5H5.4M18.6 5h-1.4M8.3 1.3l1 1M15.7 1.3l-1 1" />
      {/* panel, drawn in perspective: wider at the bottom */}
      <path d="M6.4 13h11.2l2.4 8.2H4z" />
      {/* cell divisions */}
      <path d="M8.1 13l-1.2 8.2M15.9 13l1.2 8.2M5.6 17.1h12.8" />
    </g>
  );
}

/** House with a gabled roof. */
export function HomeIcon({ size = 24 }: IconProps) {
  return (
    <g class="icon" {...box(size)}>
      <path d="M3.4 11.2 12 4.2l8.6 7" />
      <path d="M5.6 12.6v7.9h12.8v-7.9" />
      <path d="M10 20.5v-4.6h4v4.6" />
    </g>
  );
}

/**
 * Battery cell, landscape, with the fill bar tracking state of charge.
 *
 * The fill makes the icon carry information rather than decorate — it agrees with the hero meter
 * without repeating the number.
 */
export function BatteryIcon({ size = 24, soc }: IconProps & { soc?: number | null }) {
  const INNER_X = 4.6;
  const INNER_W = 12.4;
  const fraction = soc === null || soc === undefined || !Number.isFinite(soc)
    ? null
    : Math.max(0, Math.min(100, soc)) / 100;

  return (
    <g class="icon" {...box(size)}>
      <rect x="3.2" y="7.4" width="15.2" height="9.2" rx="1.8" />
      {/* terminal */}
      <path d="M20.2 10.4v3.2" />
      {fraction !== null && fraction > 0.02 && (
        <rect
          class="icon-fill"
          x={INNER_X}
          y="9"
          width={INNER_W * fraction}
          height="6"
          rx="0.7"
        />
      )}
    </g>
  );
}

/** Transmission pylon — the clearest single symbol for "the grid". */
export function GridIcon({ size = 24 }: IconProps) {
  return (
    <g class="icon" {...box(size)}>
      {/* tapered tower legs */}
      <path d="M8.2 21.2 10.7 4h2.6l2.5 17.2" />
      {/* cross-braces */}
      <path d="M9.6 14.6h4.8M9 18h6" />
      {/* arms */}
      <path d="M5.6 8.6h12.8M7.2 11.6h9.6" />
      {/* top */}
      <path d="M12 4V2.4" />
    </g>
  );
}

/**
 * The IEC inverter symbol: a square split by a diagonal, DC on one side, AC on the other.
 *
 * Recognisable to anyone who has looked at an electrical schematic, and unambiguous in a way a
 * generic box is not.
 */
export function InverterIcon({ size = 24 }: IconProps) {
  return (
    <g class="icon" {...box(size)}>
      <rect x="3" y="3" width="18" height="18" rx="2.4" />
      <path d="M19 5 5 19" />
      {/* DC: a solid line over a dashed one */}
      <path d="M6.6 8.2h4.6" />
      <path d="M6.6 10.8h1.4M9.8 10.8h1.4" />
      {/* AC: a sine wave */}
      <path d="M13 15.4c.8-1.6 1.6-1.6 2.4 0s1.6 1.6 2.4 0" />
    </g>
  );
}

/** Warning triangle, paired with a word wherever a fault colour is used. */
export function AlertIcon({ size = 24 }: IconProps) {
  return (
    <g class="icon" {...box(size)}>
      <path d="M12 4.4 21.2 20H2.8z" />
      <path d="M12 10.2v4.4" />
      <path d="M12 17.4v.1" />
    </g>
  );
}
