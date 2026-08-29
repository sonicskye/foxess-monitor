# Progress

**The single source of truth for status.** A step is not done until its line here moves.
Read the **Resume here** block at the bottom first.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Step 0 — Scaffold & continuity docs

- [x] `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- [x] `docs/API-NOTES.md` — verified API reference (auth, endpoints, variables, limits)
- [x] `docs/DECISIONS.md` — seeded with the six founding decisions
- [x] `docs/PROGRESS.md` — this file
- [x] `CLAUDE.md`
      verified: `npm install` succeeds; `npm run typecheck` passes on an empty `src/`

## Step 1 — Logging

- [x] `src/log.ts` — structured JSON logger, levels, TTY pretty mode, **redaction**,
      `createTransitionLogger` (log state changes once, not once per poll), crash handlers
- [x] `src/localdate.ts` — local-day arithmetic shared by budget, samples and audit
- [x] `src/audit.ts` — `data/api-calls-YYYY-MM-DD.ndjson` append + prune
- [x] `test/log.test.ts` — redaction strips the API key and any `signature` value
- [x] `test/localdate.test.ts` — DST boundaries in both directions
      files: src/log.ts, src/localdate.ts, src/audit.ts, test/log.test.ts, test/localdate.test.ts
      verified: `npm test` 26/26 · `npm run typecheck` clean

> Note: the audit trail uses **day-files**, not the single `api-calls.ndjson` the plan sketched.
> Pruning is then an unlink rather than a whole-file rewrite — the laptop can lose power at any
> moment, and rewriting the history to drop old lines is the one operation that could lose all of it.

## Step 2 — Request signing

- [x] `src/foxess/sign.ts` — md5 over `path\r\ntoken\r\ntimestamp` (**literal** backslashes),
      `signablePath` strips origin + query
- [x] `test/sign.test.ts` — two golden vectors, plus an assertion that the CRLF variant differs
      files: src/foxess/sign.ts, test/sign.test.ts
      verified: `npm test` — golden vectors pass

## Step 3 — Config & budget

- [x] `src/config.ts` — env parsing, defaults, projected-daily-calls validator (refuses to start
      over `DAILY_CALL_BUDGET`), collects all problems at once, registers the key for redaction
- [x] `src/budget.ts` — persisted daily counter, local-midnight rollover, per-path 1.1 s gate,
      escalating `40400` backoff, `reconcile()` against getAccessCount
- [x] `test/config.test.ts`, `test/budget.test.ts`
      files: src/config.ts, src/budget.ts, test/config.test.ts, test/budget.test.ts
      verified: `npm test` 84/84 · `npm run typecheck` clean

> **Finding: 60 s live polling is impossible.** 1440 real calls/day *is* the entire FoxESS ceiling,
> so even reducing the totals and quota jobs to once a day overshoots (1443). Even 75 s does not fit
> alongside 10-minute totals (1464). **90 s is the fastest live poll that works** — which is what
> the defaults use. Both bounds are pinned in `test/config.test.ts`.

## Step 4 — API client

- [x] `src/foxess/types.ts` — response shapes, `FoxApiError` / `BudgetDeniedError`, errno meanings
- [x] `src/foxess/client.ts` — signed `fetch`, envelope unwrapping, rationed retries, audit hook
- [x] `src/foxess/endpoints.ts` — the 7 read-only calls; the only file that names FoxESS paths
- [x] `src/probe.ts` — `npm run probe`, exactly 3 real calls
- [x] `test/client.test.ts`
      files: src/foxess/{types,client,endpoints}.ts, src/probe.ts, test/client.test.ts
      verified: `npm test` 109/109 · typecheck clean · config-refusal paths smoke-tested
- [ ] **Needs the owner:** run `npm run probe` against the real account to confirm the signature
      works end to end. Everything else in this step is verified offline against a stubbed fetch.

## Step 5 — Domain model & storage

- [x] `src/normalize.ts` — raw variables → `Snapshot`; signed grid/battery; staleness;
      `normalizeDayTotals`, `normalizeHistory`, `parseInverterTime`
- [x] `src/store.ts` — NDJSON append/read/backfill/prune + `downsample`
- [x] `test/normalize.test.ts` — both sign conventions, missing-vs-zero, staleness, time parsing
- [x] `test/store.test.ts` — downsampling, gap preservation, retention, torn-line recovery
      files: src/normalize.ts, src/store.ts, test/normalize.test.ts, test/store.test.ts
      verified: `npm test` 166/166 · typecheck clean

> Two invariants worth keeping: a missing variable normalises to **null, never 0** (a grid-tied
> inverter with no battery must not read as "0 kW battery"), and an outage longer than 10 minutes
> becomes an explicit **null break** in the series so the chart shows a hole rather than a straight
> line drawn across hours the inverter was offline.

## Step 6 — Poller & server

- [x] `src/mock.ts` — synthetic day (solar bell curve, morning/evening load peaks, battery that
      charges on surplus and holds a 10% reserve), zero API calls
- [x] `src/poller.ts` — per-job schedules, idle slowdown, startup backfill, SSE broadcast,
      per-job health tracking; a failing job costs one poll, never the schedule
- [x] `src/server.ts` — `node:http`; `/api/snapshot`, `/api/series`, `/api/stream`,
      `/api/diagnostics`, `/healthz`, static with traversal guard
- [x] `test/server.test.ts` — routes, SSE, read-only enforcement, traversal, key leakage
      files: src/mock.ts, src/poller.ts, src/server.ts, test/server.test.ts
      verified: `npm test` 191/191 · typecheck clean · ran live in mock mode and exercised every
      route with curl

> **Bug found and fixed while verifying:** `downsample()` judged gaps on the spacing of its *output*
> points. Reducing a full day to a few hundred points makes consecutive points tens of minutes
> apart, so every interval tripped the 10-minute outage threshold and the chart came back as a
> dotted line of nulls. Gaps are now judged on the source sample times. Two regression tests pin it.

> **New knob:** `MOCK_OFFSET_HOURS` shifts the simulated clock so UI work can target midday export
> or evening discharge instead of whatever hour it happens to be. Mock mode only.

## Step 7 — Frontend

- [x] `web/` Vite + Preact scaffold, theme tokens (light/dark, validated palette)
- [x] `FlowDiagram` — SVG, CSS-only animation, reduced-motion safe
- [x] `SocMeter` — hero figure, same-ramp track, low-SOC states with icon + label
- [x] `StatTile` / live tiles / today's totals strip
- [x] `IntradayChart` (3 series, signed axis) + diverging grid strip on a shared x-axis
- [x] Table view toggle (`t`) — every value reachable without hover
- [x] `Diagnostics` panel behind the `d` key
- [x] `useSize` — charts drawn at true pixel size
- [x] `test/format.test.ts` — direction and SOC-threshold logic
      files: web/{index.html,vite.config.ts,tsconfig.json}, web/src/**, test/format.test.ts
      verified: `npm test` 213/213 · `npm run typecheck` clean (both projects) ·
      screenshotted at 1366×768 in light, dark, reduced-motion, table, diagnostics, phone,
      low-SOC, critical-SOC and stale states. No page scroll at 1366×768, no console errors.
      Bundle 35 KB JS + 11 KB CSS.

> **Three bugs found by looking at the rendered page, not by tests:**
> 1. The power plot used `Math.abs()`, so a **discharging battery drew identically to a charging
>    one**. The axis now includes negatives with zero as a real baseline.
> 2. The SVG used `preserveAspectRatio="none"`, which stretched the tick labels horizontally and
>    gave the element an intrinsic height that overflowed its flex parent. Charts are now measured
>    with `ResizeObserver` and drawn in real pixels.
> 3. Tiles read `+0.90 kW discharging` — the sign contradicted the word. Tiles now show magnitude
>    plus a direction word.

## Step 8 — Deploy

- [x] `deploy/foxess-monitor.service` — systemd unit, hardened, restart-limited
- [x] `deploy/kiosk.sh` — browser kiosk launcher; waits for `/healthz`, disables screen blanking
- [x] `docs/RUNBOOK.md` — install, daily use, diagnosing (stale / quota / 40256 / 40400), updating
- [x] `README.md` — setup from zero
      files: deploy/*, docs/RUNBOOK.md, README.md
      verified: `systemd-analyze verify` on the unit · `bash -n` on the script ·
      **the compiled `dist/server.js` run end to end**, serving the built frontend

> `systemd-analyze verify` caught a real bug: `StartLimitBurst` / `StartLimitIntervalSec` were in
> `[Service]`, where systemd **silently ignores them**. They belong in `[Unit]`. The restart limiter
> would have done nothing.

## Step 9 — Flow diagram: inverter as hub, drawn icons, live status

- [x] `web/src/components/Icons.tsx` — **new**: solar panel, house, battery (fill tracks SOC),
      transmission pylon, IEC inverter symbol, alert triangle. SVG paths in `currentColor`, not
      emoji — a glyph like `▭` depends on the machine's fonts and cannot be themed.
- [x] `FlowDiagram.tsx` rewritten — four edges all incident on the **inverter**; card nodes with
      icon, label, value and status; `aria-label` built from live values
- [x] Battery status (`charging` / `discharging` / `idle` / `not fitted`) and grid status
      (`importing` / `exporting` / `balanced`) on the cards
- [x] `runningStateLabel()` in `web/src/format.ts` + the real 160–170 enum
- [x] `--grid` identity colour; `styles.css` flow block rewritten for cards
- [x] `src/mock.ts` — `runningState` 1 → 163, `generationPower` → `load + export`
      files: web/src/components/{Icons,FlowDiagram}.tsx, web/src/{format.ts,theme.css,styles.css,app.tsx},
      src/mock.ts, test/format.test.ts
      verified: `npm test` 218/218 · typecheck clean · flow panel screenshotted in export, evening
      draw, off-grid, fault and no-battery states, light and dark, no page scroll at 1366×768

> **Three bugs fixed here:**
> 1. The old diagram made **Home** the hub, so it showed the house exporting to the grid. In a
>    hybrid system everything meets at the inverter — see `DECISIONS.md` §7.
> 2. `.flow-card.is-dim` never worked: the component set `color` inline, and an inline style beats a
>    class rule, so idle nodes kept their full-strength accent. Resolved in the component instead.
> 3. `--grid-export` is the *same hex* as `--home`, so on any sunny afternoon the mirrored Grid and
>    Home cards were identical blue. Grid now has a fixed identity colour — `DECISIONS.md` §8.

> **Also found:** the mock had been sending `runningState: 1` since it was written. The real codes
> are 160–170; nothing consumed the field until now, so it went unnoticed. The enum is in
> `API-NOTES.md`, and `runningStateLabel()` reports an unknown code rather than guessing.

## Step 10 — Usable battery charge, and a layout that scales

- [x] `batteryEnergy()` + `deriveCapacityKwh()` + `parseNameplateCapacityKwh()` in `src/normalize.ts`
- [x] `battery/soc/get` endpoint (read-only) and a six-hourly settings job, skipped when the
      inverter has no battery; `projectDailyCalls()` counts it (1272 -> **1276**/day)
- [x] Capacity derived from telemetry with an EMA, seeded from the `capicty` nameplate
- [x] `SocMeter` — stored / usable / reserved rows, reserve band drawn on the meter, severity
      measured against the floor
- [x] Fluid root font size; ~150 px values converted to rem; `--ui-scale` on `+`/`−`, persisted
- [x] Portrait flow-diagram geometry for phones; phone and portrait-tablet layouts; touch targets
      files: src/{normalize,poller,config,server,mock}.ts, src/foxess/{endpoints,types}.ts,
      web/src/** , test/{normalize,config,server}.test.ts, docs/**
      verified: `npm test` 234/234 · typecheck clean · resolution matrix 1024x600 -> 3840x2160
      plus tablet and phone, light and dark — no scroll on any desktop size, no console errors ·
      below-floor / off-grid / no-battery states screenshotted

> **Three scaling bugs, all found only by rendering at 4K:**
> 1. Flow-diagram SVG text was converted to `rem` along with everything else. That SVG scales via
>    its viewBox, so rem scaled the text a *second* time and the values burst out of their cards.
>    SVG text must stay in user units.
> 2. The intraday chart is the opposite case — it draws 1:1 in CSS pixels, so its labels *should*
>    scale, but its padding constants did not, and the axis figures and import/export captions were
>    clipped. `PAD` is now in multiples of the root font size.
> 3. `grid-template-rows: minmax(0, 300px)` is not a `height`, so a property-name-driven px->rem
>    pass skips it. The top row stayed a 300px sliver at 4K while the chart took the rest.

> Root size lands at **14.4px on 1366×768**, so the original target is pixel-unchanged; it scales to
> ~20px at 1080p and caps at 32px for a 4K wall display.

---

## Done

All ten steps complete. 218 tests, typecheck clean on both projects, production build verified.

**The one thing not yet verified: no request has ever been made to the real FoxESS API.**
Everything is tested against a stubbed fetch and a synthetic day. Run `npm run probe` with a real
`FOXESS_API_KEY` to close that out — it spends 3 calls and prints the live variable table.

---

## Resume here

**Current step:** none — the build is complete.

**State:** All ten steps done. 234 tests green, typecheck clean, production build verified by
running `dist/server.js` and exercising every route.

**Next command:**

```sh
cp .env.example .env      # set FOXESS_API_KEY and TZ
npm run probe             # 3 real API calls — the only unverified path
```

**Open questions for the owner:** `npm run probe` against the real account. Two things to check
when it runs: that the signature works at all (a `40256` means read `DECISIONS.md` §1 and
`RUNBOOK.md` first), and **what `batteryList[].capicty` actually contains** — its units are
undocumented, so `parseNameplateCapacityKwh()` guesses by magnitude and should be checked against a
real value. The telemetry-derived capacity does not depend on it.

**Ideas if the project is picked up again**, none of them started:

- Multi-inverter UI: the backend already discovers and polls several, but the header has no device
  switcher, so only the first is shown.
- The flow diagram shows one inverter. A multi-inverter site would need either a hub per inverter or
  an aggregated view.
- Multi-day history: samples are retained for 14 days but only today is charted.
- Cost/tariff overlay on the grid strip.

**Watch out for:**

- The signature's `\r\n` is **literal**, not CRLF — see `DECISIONS.md` §1. This blocks all API work.
- Do all UI work with `FOXESS_MOCK=1`. Real calls cost quota against a hard 1440/day ceiling.
- This project is read-only. Do not import a FoxESS `*/set` endpoint.
