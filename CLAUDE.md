# CLAUDE.md

A read-only web dashboard for a FoxESS solar/battery system. It runs unattended on an old laptop
(Toshiba Portégé Z10t — Celeron, 4 GB, 1366×768) as a wall display, showing battery SOC, solar
generation, home consumption and grid import/export.

## Read this first

**[`docs/PROGRESS.md`](docs/PROGRESS.md)** — current status and a "Resume here" block with the exact
next command. It is the source of truth for what is and isn't done.

Then, as needed:

- [`docs/API-NOTES.md`](docs/API-NOTES.md) — the verified FoxESS API reference. **The official docs
  are a JS SPA that cannot be fetched with `curl` or a fetch tool** — it returns a loading shell.
  Use this file instead of trying to re-scrape them.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — why things are the way they are.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operating it on the laptop.
- [`docs/SMART-HOME.md`](docs/SMART-HOME.md) — consuming the data from Home Assistant, MQTT or a
  script, and why a second FoxESS integration must not share the API key.

## Three rules

1. **Read-only.** Never import a FoxESS `*/set` endpoint. The API key is not scoped — it *can*
   change inverter settings, which is exactly what this project exists to avoid. Adding a write
   path is a change of purpose, not a feature.

2. **API calls are a hard-capped resource: 1440/day per inverter.** The scheduled polling already
   budgets ~1272 of them. Do all UI and frontend work with `FOXESS_MOCK=1`, which serves a synthetic
   day and makes zero real calls. `npm run probe` is the cheap real check — exactly 3 calls.

3. **The signature `\r\n` is literal, not CRLF.** `md5(path + "\r\n" + token + "\r\n" + timestamp)`
   where `\r\n` is backslash-r-backslash-n as four characters. In TS: `` `${path}\\r\\n…` ``. Real
   CRLF returns `40256 illegal signature`. `test/sign.test.ts` guards this — don't "fix" it.

## Layout

```
src/           server — ZERO runtime dependencies (node:http, native fetch, node:crypto)
  foxess/      signing, HTTP client, endpoint wrappers
web/           frontend — Vite + Preact, hand-rolled SVG charts (no chart library)
test/          node:test
docs/          progress, decisions, API reference, runbook
deploy/        systemd unit + kiosk launcher
data/          gitignored runtime state: samples, budget counter, API audit trail
```

## Commands

```sh
npm install
npm run typecheck          # strict TS, server + web
npm test                   # node:test
FOXESS_MOCK=1 npm run dev  # full app on synthetic data, zero API calls
npm run probe              # 3 real API calls — verifies credentials
npm run build && npm start # production
```

## Conventions

- Node ≥ 20.6, ESM, strict TypeScript. Server compiles via `tsc` to `dist/` so the target laptop
  needs only a plain Node runtime.
- No runtime dependencies in `src/`. Keep it that way — see `DECISIONS.md` §6.
- All logging goes through `src/log.ts`, which redacts the API key and signatures. Never
  `console.log` a request header.
- Sign conventions in `Snapshot`: `batteryKw` **positive = charging**, `gridKw` **positive =
  importing**. Normalise at the boundary in `src/normalize.ts`; components never re-derive signs.
- Chart colours come from the validated palette in `web/src/theme.ts`. Changing them means re-running
  the dataviz validator — the current set was chosen because four-hue alternatives failed
  colour-blindness gates.
- One commit per completed step, conventional messages, tree green (`npm test && npm run typecheck`).
  Update the relevant `docs/PROGRESS.md` line in the same commit.
