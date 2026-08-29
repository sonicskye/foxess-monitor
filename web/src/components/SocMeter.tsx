/**
 * Battery state of charge — the dashboard's hero figure.
 *
 * It is the first thing the display exists to answer, so it gets the one hero number on the page
 * (≥48px, same system sans as everything else, proportional figures — `tabular-nums` makes a large
 * standalone number look loose).
 *
 * The meter track is a lighter step of the battery ramp rather than a neutral grey, so state reads
 * across the whole bar. Below 20% the fill takes the warning colour and below 10% the critical one
 * — but each low state also gets an icon AND a word, because a status colour must never be the only
 * thing carrying the meaning.
 */

import type { Snapshot } from '../api.ts';
import { kwh, percent, socLevel } from '../format.ts';

const LEVEL_COLOR = {
  normal: 'var(--battery)',
  low: 'var(--warning)',
  critical: 'var(--critical)',
} as const;

const LEVEL_LABEL = {
  normal: null,
  low: { icon: '▲', text: 'Low' },
  critical: { icon: '▲', text: 'Critical' },
} as const;

export function SocMeter({ snapshot }: { snapshot: Snapshot | null }) {
  const soc = snapshot?.soc ?? null;
  const level = socLevel(soc);
  const badge = LEVEL_LABEL[level];
  const fraction = soc === null ? 0 : Math.max(0, Math.min(100, soc)) / 100;

  return (
    <div class="soc">
      <div class="soc-head">
        <span class="soc-label">Battery charge</span>
        {badge && (
          <span class="soc-badge" style={{ color: LEVEL_COLOR[level] }}>
            <span aria-hidden="true">{badge.icon}</span> {badge.text}
          </span>
        )}
      </div>

      <div class="soc-figure">
        <span class="soc-value">{percent(soc)}</span>
        <span class="soc-unit">%</span>
      </div>

      <div
        class="soc-track"
        role="meter"
        aria-valuenow={soc ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Battery state of charge"
      >
        <div
          class="soc-fill"
          style={{ width: `${fraction * 100}%`, background: LEVEL_COLOR[level] }}
        />
      </div>

      <div class="soc-foot">
        <span>{kwh(snapshot?.residualKwh)} kWh remaining</span>
        {snapshot?.soh != null && <span class="soc-soh">{percent(snapshot.soh)}% health</span>}
      </div>
    </div>
  );
}
