/**
 * Battery state of charge — the dashboard's hero figure.
 *
 * It is the first thing the display exists to answer, so it gets the one hero number on the page
 * (≥48px, same system sans as everything else, proportional figures — `tabular-nums` makes a large
 * standalone number look loose).
 *
 * Stored is not the same as usable. The inverter will not discharge below a minimum SOC, so on a
 * 10.4 kWh pack with a 20% floor about 2 kWh of what the API calls "remaining" can never reach the
 * house. Both figures are shown, and the reserved band is drawn on the meter track itself so the
 * real headroom is visible without reading the numbers.
 *
 * The track is a lighter step of the battery ramp rather than neutral grey, so state reads across
 * the whole bar. Below the low thresholds the fill takes the warning or critical colour — always
 * with an icon AND a word, because a status colour must never carry the meaning alone.
 */

import type { BatteryEnergy, Snapshot } from '../api.ts';
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

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div class="soc-row">
      <span class="soc-row-label">{label}</span>
      <span class="soc-row-value">{value}</span>
      {note && <span class="soc-row-note">{note}</span>}
    </div>
  );
}

export function SocMeter({
  snapshot,
  battery,
}: {
  snapshot: Snapshot | null;
  battery: BatteryEnergy | null;
}) {
  const soc = snapshot?.soc ?? null;
  const floor = battery?.floorPercent ?? null;

  // Severity is measured against the floor, not against zero: 12% on a 10% floor is nearly empty,
  // while the same 12% on a 0% floor is not.
  const headroom = soc === null ? null : soc - (floor ?? 0);
  const level = socLevel(headroom);
  const badge = LEVEL_LABEL[level];

  const fraction = soc === null ? 0 : Math.max(0, Math.min(100, soc)) / 100;
  const floorFraction = floor === null ? 0 : Math.max(0, Math.min(100, floor)) / 100;

  return (
    <div class="soc">
      <div class="soc-head">
        <span class="soc-label">Battery charge</span>
        {badge ? (
          <span class="soc-badge" style={{ color: LEVEL_COLOR[level] }}>
            <span aria-hidden="true">{badge.icon}</span> {badge.text}
          </span>
        ) : (
          snapshot?.soh != null && <span class="soc-health">{percent(snapshot.soh)}% health</span>
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
        aria-label={
          floor === null
            ? 'Battery state of charge'
            : `Battery state of charge, ${percent(soc)}% with a ${floor}% reserve`
        }
      >
        <div class="soc-fill" style={{ width: `${fraction * 100}%`, background: LEVEL_COLOR[level] }} />
        {/* The reserved band sits over the fill: energy that is really there but cannot be used. */}
        {floorFraction > 0 && (
          <>
            <div class="soc-reserve" style={{ width: `${floorFraction * 100}%` }} />
            <div class="soc-floor-mark" style={{ left: `${floorFraction * 100}%` }} />
          </>
        )}
      </div>

      <div class="soc-rows">
        <Row label="Stored" value={`${kwh(battery?.storedKwh ?? snapshot?.residualKwh)} kWh`} />
        <Row
          label="Usable"
          value={`${kwh(battery?.usableKwh)} kWh`}
          note={battery?.usablePercent == null ? undefined : `${percent(battery.usablePercent)}%`}
        />
        <Row
          label="Reserved"
          value={floor === null ? '—' : `${floor} %`}
          note={battery?.reservedKwh == null ? undefined : `${kwh(battery.reservedKwh)} kWh`}
        />
      </div>
    </div>
  );
}
