/** Number and time formatting. Kept in one place so units read consistently everywhere. */

const EM_DASH = '—';

/** Power in kW, two decimals below 10 and one above, so the column stays a readable width. */
export function kw(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const magnitude = Math.abs(value);
  if (magnitude < 0.01) return '0.00';
  return magnitude < 10 ? magnitude.toFixed(2) : magnitude.toFixed(1);
}

export function kwh(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return `${(magnitude / 1000).toFixed(1)}k`;
  return magnitude < 10 ? magnitude.toFixed(2) : magnitude.toFixed(1);
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return String(Math.round(value));
}

export function degrees(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toFixed(1);
}

export function clockTime(iso: string | number | null | undefined, timeZone: string): string {
  if (iso === null || iso === undefined) return EM_DASH;
  const at = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (Number.isNaN(at.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

export function clockTimeWithSeconds(iso: string | number | null | undefined, timeZone: string): string {
  if (iso === null || iso === undefined) return EM_DASH;
  const at = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (Number.isNaN(at.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(at);
}

/** "3 min ago" — for the staleness badge, where the age is the message. */
export function relativeAge(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return 'unknown';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Grid direction as words, since colour alone must never carry the meaning. */
export function gridDirection(gridKw: number | null): 'import' | 'export' | 'idle' {
  if (gridKw === null || !Number.isFinite(gridKw) || Math.abs(gridKw) < 0.01) return 'idle';
  return gridKw > 0 ? 'import' : 'export';
}

export function batteryDirection(batteryKw: number | null): 'charging' | 'discharging' | 'idle' {
  if (batteryKw === null || !Number.isFinite(batteryKw) || Math.abs(batteryKw) < 0.01) return 'idle';
  return batteryKw > 0 ? 'charging' : 'discharging';
}

/** Low-battery severity. Drives the meter colour AND an icon + label — never colour alone. */
export type SocLevel = 'normal' | 'low' | 'critical';

export function socLevel(soc: number | null): SocLevel {
  if (soc === null || !Number.isFinite(soc)) return 'normal';
  if (soc < 10) return 'critical';
  if (soc < 20) return 'low';
  return 'normal';
}
