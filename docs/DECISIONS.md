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

---

## 7. The inverter is the hub of the flow diagram, not the house

**Decision.** The energy-flow diagram has four edges, all incident on the **inverter**:
Solar → Inverter, Inverter → Home, Inverter ↔ Battery, Inverter ↔ Grid.

**Why.** The first version drew three edges — solar→home, battery↔home, grid↔home — which made
*Home* the hub. It looked plausible and was wrong: it showed the house exporting to the grid.

In a FoxESS hybrid system (H1/H3 and similar) the PV strings, the battery and the grid connection
all terminate at the inverter, and the house loads hang off it. There is no path between the house
and the grid that does not go through the inverter. Drawing one misrepresents how the system works,
and it is the sort of error that quietly teaches the owner something false about their own house.

Solar → Inverter and Inverter → Home are one-way: PV only ever produces, loads only ever consume.
Only the battery and grid edges reverse, and their direction comes straight from the sign
conventions in `src/normalize.ts` via `batteryDirection()` / `gridDirection()`.

**Do not reconcile the four flows.** In (`solar + discharge + import`) should roughly equal out
(`load + charge + export`), but conversion losses and per-variable measurement timing mean it will
not tie exactly. The diagram reports measured values; making them balance would mean inventing data.

---

## 8. Grid has a fixed colour in the flow diagram, and a diverging one in the chart

**Decision.** In the flow diagram the grid node is always `--grid` (magenta); direction is carried
by the arrowhead and the words "importing"/"exporting". The chart's grid strip keeps the diverging
red/blue.

**Why.** Two reasons that agree:

- **They collided.** `--grid-export` is `#2a78d6`, which is *exactly* `--home`. In the chart that is
  harmless — the grid strip and the home line never sit side by side. In the flow diagram, Grid and
  Home are mirrored across the hub, so on any sunny afternoon two adjacent cards were the identical
  blue. Measured ΔE 0.
- **Colour should follow the entity, not its state.** Repainting a node as power changes direction
  is the "recolour on filter" anti-pattern: a reader who learned "grid is the pink one" should not
  have to relearn it at sunset. The chart strip is the opposite case — there the *whole point* is
  polarity over time, so diverging is right and there is no neighbour to be confused with.

**What was measured.** Re-stepping the export blue to a darker shade was tried first and rejected:
`#184f95` vs `#2a78d6` scores normal-vision ΔE 14.7 light / 9.5 dark, under the ≥15 floor — two
blues of different lightness do not read as two identities. Of the candidate hues, magenta separates
best from home (dark: CVD ΔE 15.9, normal-vision 26.5, both passing).

**The known weak pair.** Grid magenta vs battery aqua measures CVD ΔE 1.6 (deutan) on the dark
surface — a red-green colourblind reader sees them as the same hue. Accepted because the flow
diagram is not a chart: the two nodes are perpendicular rather than mirrored, and each carries a
text label and a distinct drawn icon, so identity never rests on hue. If a fourth *chart* series is
ever wanted, this does not license it — see §5.

---

## 9. Stored energy is not usable energy

**Decision.** The battery panel reports **stored**, **usable** and **reserved** separately, and the
meter draws the reserved band. `batteryEnergy()` in `src/normalize.ts` computes all three.

**Why.** The API's `ResidualEnergy` is what is physically in the pack. The inverter will not
discharge below a minimum SOC, so on a 10.4 kWh pack with a 20% floor about 2 kWh of that can never
reach the house. Reporting it as "remaining" overstates what the owner actually has — which matters
most in exactly the situation where it is least affordable to be wrong, a nearly flat battery.

Three things follow, each deliberate:

- **The floor depends on state.** On-grid the pack is held to `minSocOnGrid`, keeping a reserve for
  a power cut; off-grid that reserve is precisely what is being spent, so the floor drops to
  `minSoc`. Usable energy therefore *rises* the moment the grid fails, without the pack changing.
- **Usable clamps at zero, never negative.** SOC can sit below the floor after an outage, or the
  instant the owner raises the floor above the current charge.
- **Low-battery severity is measured against the floor**, not zero: 12% on a 10% floor is nearly
  empty, while the same 12% on a 0% floor is not.

**Capacity** is derived from telemetry (`stored / (soc/100)`) rather than the nameplate, because it
is in real kWh and tracks the pack as it ages. The `batteryList[].capicty` nameplate has
undocumented units and only seeds the estimate before SOC has been high enough to measure. See
`API-NOTES.md`.

**Cost:** 4 API calls/day. The floor changes only when the owner changes it, so the settings poll
runs six-hourly, and it is skipped entirely on a battery-less inverter. The projection moves
1272 → 1276 of 1440.

---

## 10. One fluid root size; SVG text stays in user units

**Decision.** `html { font-size: clamp(11px, calc((0.55vw + 0.9vh) * var(--ui-scale, 1)), 32px) }`,
with the stylesheet in `rem`. Plus `+`/`−` for a persisted manual nudge.

**Why.** The CSS was hand-tuned for the Toshiba's 1366×768 panel — 39 fixed `px` font sizes and no
relative units — so every other screen got the same small text in more whitespace. One fluid root
size scales the whole dashboard, and the formula is **weighted toward viewport height** because the
layout's hard requirement is fitting without scrolling; a width-only formula collapses on a wide,
short window. It lands at ~14.4px on 1366×768, so the original target is unchanged.

**Three things that must NOT scale**, each learned by breaking it:

- **Text inside the flow diagram's SVG stays in `px` (user units).** That SVG scales through its
  viewBox, so cards and their labels already grow together. Expressing the text in `rem` scaled it a
  *second* time against the root size, and at 4K the values burst out of their cards.
- **The intraday chart is the opposite case**: it draws 1:1 with CSS pixels via `useSize`, so its
  labels are in `rem` and its padding must track the same scale — hence `PAD` in multiples of the
  root size. With fixed padding, the axis figures and the import/export captions were clipped at 4K.
- **Hairline borders and gridlines stay `1px`.** A scaled 1.4px border renders blurry; a hairline
  should stay a hairline at any size. Media-query breakpoints stay in `px` too — they describe the
  viewport, not the type.

**Grid track sizes are easy to miss.** `grid-template-rows: minmax(0, 300px)` is not a `height`, so
a naive property-name-driven conversion skips it, and the top row stays a 300px sliver on a 4K
display while the chart takes everything else.

---

## 11. A failed job retries on a short backoff; a budget-denied one does not

**Decision.** `schedule()` in `src/poller.ts` distinguishes three outcomes. On **failure** it retries
after 30 s, doubling up to the job's own interval. On **budget denial** it reschedules normally. On
**success** the backoff resets.

**Why.** It previously rescheduled at the full interval regardless, which meant the recovery time
after any transient error was the job's *period*, not its severity:

- the six-hourly settings job failing once left the battery's usable-energy figures blank **for six
  hours** — this is the bug that a brief internet outage actually produced;
- `discover` failing at startup was worse: `start()` returned early having scheduled *nothing*, so
  the process stayed up, served a page and reported healthy while polling absolutely nothing until
  someone restarted it.

Jobs that cannot run because discovery has not landed now throw `DeferredError` instead of quietly
returning. Returning success would mark a one-shot job done and never retry it; throwing gets the
retry, and the distinct type keeps the log quiet — during an outage every dependent job defers on
every tick, and logging each at `warn` with a stack buries the one line that matters.

**Budget denial is deliberately not a failure.** Nothing was sent; the quota is simply spent.
Retrying sooner would spend more of a budget that has already run out, which is how a rate limit
becomes a rate-limit *storm*. `test/poller.test.ts` pins this.

**Cost is bounded**: retries pass through `budget.acquire()` like every other call, and the backoff
is capped at the normal interval.

---

## 12. The dashboard is open on the LAN, and no request may kill the process

**Decision.** No authentication, binds `0.0.0.0`, documented rather than locked down. In exchange,
nothing a request can contain is allowed to take the process down, and the standard hardening
headers are sent.

**Why open.** Viewing it from a phone on the sofa is a real use, and a token in a kiosk URL is
friction for a read-only display on a home network. What that exposes is worth stating plainly,
because it is a **privacy** question rather than a security one: solar output, household load,
battery SOC and daily totals let anyone on the network infer **when the house is empty or everyone
is asleep**. The API key is not exposed and nothing is writable. `HOST=127.0.0.1` is the lockdown
switch for anyone who wants it.

**Why the crash-resistance matters more than it looks.** The systemd unit has `Restart=always` but
also `StartLimitBurst=5 / StartLimitIntervalSec=60`. So a request that can crash the process is not
a transient annoyance — **five of them inside a minute leave the dashboard down until someone runs
`systemctl reset-failed`**. That turned a malformed `Host` header into an unauthenticated,
persistent denial of service. Two rules follow:

- the request handler is wrapped in `try`/`catch`, and
- the URL is parsed against a **fixed base**, never `req.headers.host`. Only `pathname` and
  `searchParams` are used, so the attacker-controlled header is not consulted at all — removing the
  input rather than guarding it.

**Two header choices that are deliberate:**

- **`style-src` allows `'unsafe-inline'`.** Preact sets `style={{…}}` for every series colour, meter
  width and flow-diagram stroke; blocking it breaks the whole UI. Inline *style* is far lower risk
  than inline *script*, and `script-src` stays at `'self'` — which is why the theme bootstrap lives
  in `web/public/theme-init.js` rather than inline in `index.html`.
- **No `Strict-Transport-Security`.** This is plain HTTP on a LAN. HSTS would tell the browser to
  force HTTPS on an origin that has none, and it persists — locking every device that had once
  visited out of the dashboard. A test asserts the header stays absent, because it is exactly the
  kind of thing a security checklist would tell someone to add.

**Limits are sized for a household**: 32 concurrent SSE streams against a realistic four, and
`server.maxConnections = 256`. `requestTimeout` is disabled deliberately — SSE streams never
"finish", and a timeout there would sever live updates.

---

## 13. A known battery capacity outranks the API's `ResidualEnergy`

**Decision.** When `BATTERY_CAPACITY_KWH` is set (or a nameplate capacity is available), stored
energy is computed as `capacity × SoC / 100`. The API's `ResidualEnergy` is reported for diagnosis
but not used.

**Why.** On an EQ4800-L6 — 27.96 kWh, per the installer's invoice — the API reported
`ResidualEnergy = 26.9 kWh` at 68% SOC. That is 96% of the pack at a moment it was 68% full. The
FoxESS app showed **19.01 kWh**, which is `27.96 × 0.68` exactly. `SoC` matched the app, so
`ResidualEnergy` is the variable that cannot be trusted. The discrepancy factor (~1.41) is not a
unit conversion and what the value represents on that firmware is unknown.

Everything downstream inherited the error, because capacity was *derived from* `ResidualEnergy`:
capacity read 39.56 kWh instead of 27.96, so usable read 22.9 kWh instead of 16.22.

**This cannot regress a pack whose `ResidualEnergy` is sound.** With no configured or nameplate
capacity the estimate falls back to the telemetry-derived one — which is itself `residual ÷ soc` —
so multiplying it back by `soc` returns the original reading unchanged. A test pins that identity.

**The disagreement is surfaced, not swallowed.** `reportedResidualKwh` stays on the snapshot,
`/api/diagnostics` shows it beside `expectedFromSoc`, and `residualDisagrees()` drives a
transition-logged warning. A plausible-looking number that is quietly 40% wrong is exactly the fault
that should announce itself — this one was only caught because the owner happened to compare against
the app.

**Capacity is now displayed** beside the battery header. It was computed and sent to the browser but
never shown, which is why the error stayed invisible; without it there is no way to tell whether
"stored" is most of the pack or a fraction of it. It is formatted to two decimals rather than the
usual one, because it is a fixed figure typed in from an invoice and `27.96` confirms the setting
took effect in a way `28.0` does not.
