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

- [ ] `src/mock.ts` — synthetic 24 h day, zero API calls
- [ ] `src/poller.ts` — schedule, idle slowdown, startup backfill, SSE broadcast
- [ ] `src/server.ts` — `node:http`; `/api/snapshot`, `/api/series`, `/api/stream`,
      `/api/diagnostics`, `/healthz`, static
      verified: `FOXESS_MOCK=1 npm run dev` serves a snapshot and pushes SSE

## Step 7 — Frontend

- [ ] `web/` Vite + Preact scaffold, theme tokens (light/dark, validated palette)
- [ ] `FlowDiagram` — SVG, CSS-only animation, reduced-motion safe
- [ ] `SocMeter` — hero figure, same-ramp track, low-SOC states with icon + label
- [ ] `StatTile` / KPI row / today's totals
- [ ] `IntradayChart` (3 series) + `GridStrip` (diverging), shared x-axis
- [ ] `TableView` toggle — every value reachable without hover
- [ ] `Diagnostics` panel behind the `d` key
      verified: 1366×768, light + dark, reduced-motion, low-SOC states

## Step 8 — Deploy

- [ ] `deploy/foxess-monitor.service` — systemd unit
- [ ] `deploy/kiosk.sh` — chromium kiosk launcher
- [ ] `docs/RUNBOOK.md` — deploy, restart, read logs, diagnose quota
- [ ] `README.md` — setup from zero

---

## Resume here

**Current step:** 6 — Poller & server.

**State:** Steps 0–5 complete (166 tests green, typecheck clean). The API client is written and
fully tested against a stubbed fetch, but **has never spoken to the real API**.

**Next command:**

```sh
npm run probe    # 3 real calls — needs FOXESS_API_KEY in .env
```

**Open questions for the owner:** `.env` needs a real `FOXESS_API_KEY` before `npm run probe` can
confirm the signature works end to end. Steps 5–7 can all proceed without it, using
`FOXESS_MOCK=1`.

**Watch out for:**

- The signature's `\r\n` is **literal**, not CRLF — see `DECISIONS.md` §1. This blocks all API work.
- Do all UI work with `FOXESS_MOCK=1`. Real calls cost quota against a hard 1440/day ceiling.
- This project is read-only. Do not import a FoxESS `*/set` endpoint.
