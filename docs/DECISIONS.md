# Decisions

ADR-lite. One entry per non-obvious call, recording **why** — because these are exactly the things a
later reader would otherwise "helpfully" undo. Newest last.

---

## 1. The signature separator is a literal `\r\n`, not CRLF

**Decision.** `sign()` builds `` `${path}\\r\\n${token}\\r\\n${timestamp}` `` — backslash-r,
backslash-n as literal characters — and md5s that.

**Why.** The official docs render the rule as `url + "\r\n" + token + "\r\n" + timestamp`, which
reads like CRLF. But the reference Python implementation uses a **raw** f-string,
`fr'{path}\r\n{token}\r\n{timestamp}'`, where backslashes are literal. `macxq/foxess-ha` — known to
work in production — does the same. Using real CRLF returns `40256 illegal signature`.

**Guard.** `test/sign.test.ts` pins a golden vector and asserts explicitly that the CRLF variant
produces a *different* digest. If that test is ever "corrected", auth breaks silently.

---

## 2. The browser never talks to FoxESS

**Decision.** A Node server holds the API key, polls on a budgeted schedule, caches the result, and
pushes to browsers over SSE. The frontend only ever calls our own `/api/*`.

**Why.** Two independent reasons, either sufficient:

- **Secrecy** — the API key is not read-only. Anything the browser can see, a guest on the LAN can
  see, and that key can change inverter settings.
- **Quota** — the limit is 1440 calls/day/inverter. Browser-side polling would multiply calls by
  (tabs × viewers), and every page reload would spend more. A kiosk that reboots would be
  unpredictable. Server-side polling makes consumption a constant, independent of who's watching.

SSE over polling because the kiosk holds one connection open for days at near-zero CPU.

---

## 3. The intraday chart is built from our own samples, not `history/query`

**Decision.** Every `real/query` result is appended to `data/YYYY-MM-DD.ndjson`. The chart is served
from that file. `history/query` is called exactly **once at startup**, to backfill midnight→now.

**Why.** The live poll already runs every 90 s, so the samples are free — we're paying for that data
anyway. Polling `history/query` on a schedule would spend quota to re-fetch what we already hold.
The one startup call exists so a restart (or a reboot of the laptop) doesn't leave a truncated
graph.

**Consequence.** Chart resolution equals the poll interval, and gaps in the file are real outages —
which is useful information, so gaps are rendered as gaps, never interpolated across.

---

## 4. Battery and grid are stored as single signed numbers

**Decision.** `Snapshot.batteryKw` is **positive = charging**; `Snapshot.gridKw` is
**positive = importing**.

**Why.** The API represents each flow three different ways (`invBatPower` signed positive-on-
*discharge*, plus the split `batChargePower`/`batDischargePower`; and for the grid, the split
`gridConsumptionPower`/`feedinPower` with no signed equivalent). Leaving that to the UI would
scatter sign logic across components and invite a flipped arrow.

Positive-on-charge is the opposite of `invBatPower`'s convention — chosen because "positive = energy
going *into* the thing" matches the grid convention and how people read the diagram. The conversion
is one negation in one place, with a test that pins both directions.

`batChargePower - batDischargePower` is preferred over `-invBatPower` because it's already
normalised by the inverter; `-invBatPower` is the fallback when the split variables are absent.

---

## 5. Grid is a diverging strip, not a fourth line on the chart

**Decision.** The intraday chart carries three categorical series — Solar, Home, Battery. Grid gets
its own diverging strip below it, sharing the x-axis: import above the zero line, export below.

**Why.** Two reasons that point the same way:

- **Accessibility, measured.** Four all-pairs-distinct hues could not clear the CVD gates. Every
  candidate was run through the dataviz validator and failed in dark mode — e.g. violet↔blue ΔE 1.9
  (protan), magenta↔aqua ΔE 1.6 (deutan), both far below the ≥8 target. The three-hue set
  (`#eb6834` / `#2a78d6` / `#1baf7a` light) passes every check in both modes: worst CVD ΔE 9.2
  light, 9.4 dark.
- **It's the right form anyway.** Grid flow is inherently *signed* — the question is "importing or
  exporting?". That is a diverging encoding, not a categorical one. Rendering it as a fourth
  same-looking line would have obscured the polarity that matters most.

---

## 6. Zero runtime dependencies; `node:http` instead of a framework

**Decision.** The server imports nothing outside the Node standard library. `typescript`, `vite` and
`preact` are dev dependencies only, and the frontend ships hand-rolled SVG rather than a chart
library.

**Why.** The target is a Toshiba Portégé Z10t — Celeron, 4 GB RAM, 1366×768 — running unattended for
months. Fewer dependencies means less memory, faster cold start, no supply-chain surface on a box
nobody will update, and no dependency rot in a project that may sit untouched for a year. The
routing needed here is four routes and a static handler; a framework would be more code than it
saves. A charting library would dwarf the rest of the bundle, and the flow diagram is bespoke SVG
regardless.

**Consequence.** Requires Node ≥ 20.6 (native `fetch`, `--env-file`). The server is compiled by
`tsc` to plain JS rather than relying on the runtime's TypeScript support, so the deployed laptop
only needs a plain Node runtime.
