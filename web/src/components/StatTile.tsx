/**
 * A labelled figure.
 *
 * Values wear text tokens, never the series colour — a light hue like aqua is illegible as text on
 * the light surface. Identity comes from the small coloured dot beside the label.
 */

import type { JSX } from 'preact';

export function StatTile({
  label,
  value,
  unit,
  color,
  note,
  emphasis,
}: {
  label: string;
  value: string;
  unit?: string;
  /** Series colour for the identity dot, if this figure belongs to a charted series. */
  color?: string;
  note?: JSX.Element | string;
  emphasis?: boolean;
}) {
  return (
    <div class={`tile${emphasis ? ' is-emphasis' : ''}`}>
      <div class="tile-label">
        {color && <span class="tile-dot" style={{ background: color }} aria-hidden="true" />}
        {label}
      </div>
      <div class="tile-value">
        {value}
        {unit && <span class="tile-unit">{unit}</span>}
      </div>
      {note && <div class="tile-note">{note}</div>}
    </div>
  );
}
