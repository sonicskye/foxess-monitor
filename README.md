# foxess-monitor

A **read-only** web dashboard for a FoxESS solar and battery system, built to sit on an old laptop
as an always-on wall display.

The only way to see a FoxESS system's live state today is the FoxCloud 2.0 mobile app — which is
also a full control surface that can change inverter settings. This is the read-only view: it shows
battery charge, solar generation, household consumption and grid import/export, and it cannot
change anything.

<!-- Screenshot: light and dark at 1366×768 -->

## What it shows

- **Battery charge** as the headline figure, with remaining kWh, health, and a low-battery warning
  that carries an icon and a word as well as a colour.
- **A live energy flow diagram** — where power is going right now between solar, home, battery and
  grid, with direction shown by arrowheads, numbers and animation.
- **Today's totals** — solar generated, home consumed, imported, exported, battery charged and
  discharged.
- **An intraday chart** of solar, home and battery power, with a diverging strip below showing grid
  import above the line and export below.
- Light and dark themes, a data-table view of every charted value, and a diagnostics panel.

## Requirements

- Node.js ≥ 20.6
- A FoxESS Cloud API key: **User Profile → API Management → Generate API key**

## Quick start

```sh
git clone <this repo> && cd foxess-monitor
npm ci
cp .env.example .env        # then set FOXESS_API_KEY and TZ
npm run build
npm run probe               # 3 API calls — confirms the key and signature work
npm start                   # http://localhost:8080
```

To try it without an API key at all:

```sh
FOXESS_MOCK=1 MOCK_OFFSET_HOURS=9 npm run dev
```

For deployment on the display machine — systemd unit, kiosk browser, diagnosing problems — see
**[`docs/RUNBOOK.md`](docs/RUNBOOK.md)**.

## How it works

```
Browser ──SSE, one connection──► Node server ──polled on a budget──► FoxESS Cloud
                                    │
                                    ├── in-memory snapshot
                                    └── data/*.ndjson  (samples, API audit, budget)
```

The browser never talks to FoxESS. Two reasons, either sufficient on its own:

- **The API key is a live credential.** It is not scoped to read-only — it *can* change inverter
  settings. Anything the browser can see, a guest on your network can see.
- **FoxESS allows 1440 API calls per day per inverter.** Browser-side polling would multiply that
  by the number of tabs and viewers, and every page reload would spend more. Polling server-side
  makes consumption a constant, whoever is watching.

The default schedule uses about **1272 calls a day (88% of the ceiling)**, leaving headroom for
restarts and retries:

| Job | Interval | Calls/day |
|---|---:|---:|
| live data | 90 s | 960 |
| generation summary | 10 min | 144 |
| day totals | 10 min | 144 |
| quota check | 60 min | 24 |

Three things keep that honest: the process **refuses to start** if the configured intervals project
over budget; a persisted counter that a crash loop cannot reset gates every request; and every call
is written to an audit log so the model can be checked against reality afterwards.

One-minute polling is not achievable, incidentally — 1440 live calls *is* the entire allowance, so
even reducing everything else to once a day overshoots. 90 seconds is the fastest that works.

The intraday chart costs no extra calls: the live poll's own samples are appended to a daily NDJSON
file, with a single `history/query` at startup to backfill from midnight so a restart doesn't
truncate the graph.

## Configuration

All via `.env` — see [`.env.example`](.env.example) for the annotated list. The essentials:

| | |
|---|---|
| `FOXESS_API_KEY` | required (unless `FOXESS_MOCK=1`) |
| `TZ` | e.g. `Europe/London` — decides where "today" starts |
| `POLL_REAL_SECONDS` | live refresh, default `90` |
| `HOST` | `0.0.0.0` to view from other devices, `127.0.0.1` to keep it local |
| `FOXESS_MOCK` | `1` for synthetic data and zero API calls |

## Development

```sh
npm test                      # node:test
npm run typecheck             # strict TS, server + web
FOXESS_MOCK=1 npm run dev     # backend on synthetic data
npm run dev:web               # Vite dev server, proxies /api to the backend
```

The server has **zero runtime dependencies** — `node:http`, native `fetch`, `node:crypto`. Only
`typescript`, `vite` and `preact` are dev dependencies, and the frontend ships hand-rolled SVG
rather than a charting library. The target is a Celeron with 4 GB of RAM running unattended for
months, so the bundle is 35 KB of JS and there is no dependency tree to rot.

Further reading:

- [`CLAUDE.md`](CLAUDE.md) — conventions and the three rules
- [`docs/API-NOTES.md`](docs/API-NOTES.md) — verified FoxESS API reference (the official docs are a
  JS SPA that can't be fetched, so this exists to save you scraping them)
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — why things are the way they are
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — build status

## Read-only, by construction

Only seven FoxESS endpoints are implemented and every one is a read. The API's `set` endpoints —
minimum SOC, force-charge windows, schedules, inverter settings — are deliberately absent, and a
test asserts that no declared path is a write path. Adding one would change what this project is.

## Licence

MIT — see [LICENSE](LICENSE).
