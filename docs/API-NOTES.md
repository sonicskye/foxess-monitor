# FoxESS OpenAPI — verified reference

Extracted 2026-08-29 from the official documentation at
<https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html>.

> **Why this file exists.** <https://developer-eu.foxesscloud.com/apidoc> is a JavaScript SPA — it
> returns a loading shell to any non-browser fetch, so the docs cannot be read with `curl` or a
> fetch tool. The URL above serves the same content as static HTML. Everything below was pulled
> from it and cross-checked against working open-source clients. **Consult this file rather than
> re-scraping.** If you must refresh it:
>
> ```sh
> curl -s https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html -o /tmp/apidoc.html
> # then strip tags — the useful text is ~319 KB
> ```

Cross-checked against:

- [`macxq/foxess-ha`](https://github.com/macxq/foxess-ha) — `custom_components/foxess/sensor.py`
  (the signature implementation, confirmed working in production)
- [`TonyM1958/FoxESS-Cloud`](https://github.com/TonyM1958/FoxESS-Cloud)

---

## Getting an API key

FoxESS Cloud → **User Profile → API Management → Generate API key**. It is a bearer-equivalent
secret: it authenticates every call and is *not* scoped to read-only, so treat it accordingly.

## Base URL

`https://www.foxesscloud.com`

There is one global hostname, geo-steered by Alibaba Cloud based on site location and requester IP;
EU traffic resolves to their DE region. The official Python sample uses
`https://portal.foxesscloud.us` for US accounts. Configurable via `FOXESS_API_BASE`.

---

## Authentication

Every request carries these headers:

| Header | Value |
|---|---|
| `token` | the API key |
| `timestamp` | current time in **milliseconds**, as a string |
| `signature` | `md5(path + "\r\n" + token + "\r\n" + timestamp)`, lowercase hex |
| `lang` | `en` |
| `Content-Type` | `application/json` |
| `User-Agent` | a normal browser UA string |

### ⚠️ The `\r\n` is literal, not CRLF

This is the single most common reason FoxESS integrations fail. The separator is the
**four-character sequence** `\` `r` `\` `n` — a backslash, the letter r, a backslash, the letter n —
**not** the CR and LF control characters.

The official sample gives it away by using a Python **raw** f-string:

```python
signature = fr'{path}\r\n{token}\r\n{timestamp}'   # fr'' => backslashes are literal
```

`foxess-ha` does the same (`rf"{path}\r\n{token}\r\n{timestamp}"`). In TypeScript:

```ts
const raw = `${path}\\r\\n${token}\\r\\n${timestamp}`;   // note the doubled backslashes
```

Using real CRLF yields `40256 … illegal signature`. `test/sign.test.ts` pins this with a golden
vector; if that test is ever "fixed" to use `\r\n` control characters, authentication breaks.

### Sign the path only

The signed string uses the **path**, never the full URL and never the query string — even for GET
requests that carry query parameters. `/op/v0/device/detail?sn=ABC` is signed as
`/op/v0/device/detail`.

---

## Rate limits

- **1440 interface calls per day, per inverter**, across all endpoints combined.
- Query interfaces: **max 1 call/second**, counted **per interface** (per path).
- Update interfaces: max 1 call per 2 seconds (not used here — this project is read-only).
- Exceeding the limit returns errno `40400` and the API stops responding until the window clears.

FoxESS reserves the right to change these; `/op/v0/user/getAccessCount` reports the account's actual
`total` and `remaining`, which is the authoritative figure.

## Error codes

| errno | Meaning | Handling |
|---:|---|---|
| `0` | success | — |
| `40256` | request header parameters missing/invalid | almost always a bad signature |
| `40257` | request body parameters invalid | check the payload shape |
| `40400` | too many requests | back off hard; the daily budget is likely spent |

`errno` is in the **response body**, not the HTTP status — a failed call still returns HTTP 200.
Always check `errno`.

---

## Endpoints used by this project

All read-only. Write endpoints exist (`/battery/soc/set`, `/scheduler/set`, …) and are deliberately
not implemented — see `DECISIONS.md`.

### `POST /op/v0/device/list` — discover inverters

```json
{ "currentPage": 1, "pageSize": 500 }
```

Returns the inverters owned by the account. Used once at startup when `FOXESS_DEVICE_SN` is unset.

### `GET /op/v0/device/detail?sn=…` — device metadata

Model, station/plant name, status, and the battery list. Used once at startup.

Two capacity fields, and they are **not** the same thing:

| Field | Type | Meaning |
|---|---|---|
| `capacity` | integer | the **inverter's rated power, in kW**. Not battery energy. |
| `batteryList[].capicty` | string | the battery's capacity — **note the misspelling** |

`capicty` (sic) is in the same family as `ambientTemperation` and `chargeEnergyToTal`: reproduce it
verbatim. Its **units are undocumented**, so `parseNameplateCapacityKwh()` in `src/normalize.ts`
sums the modules and interprets by magnitude, treating anything above ~200 as watt-hours.

Because that is a heuristic, the nameplate is only used to seed the estimate. The trustworthy figure
is derived from telemetry: `ResidualEnergy / (SoC/100)`, which is in real kWh and self-calibrating
as the pack ages. It is only computed above 20% SOC, since SOC arrives as an integer percent and the
division amplifies the quantisation error near empty.

### `POST /op/v1/device/real/query` — **live data**

Note the **v1**. `/op/v0/device/real/query` still works but is marked deprecated; v0 takes a single
`sn`, v1 takes an `sns` array.

```json
{ "sns": ["SERIALNUMBER"], "variables": ["pvPower", "SoC"] }
```

- `sns` is required, max 50 entries.
- Omitting `variables` returns every variable (a much larger response — always pass the list).

Response:

```json
{ "errno": 0, "result": [
  { "deviceSN": "…", "datas": [
    { "variable": "pvPower", "unit": "kW", "name": "PVPower", "value": 3.24,
      "time": "2026-08-29 14:32:01 GMT+1" }
  ]}
]}
```

`time` is the **inverter's own local clock** in `yyyy-MM-dd HH:mm:ss zZ` format. A variable missing
from `datas` simply wasn't found and is not returned.

> **⚠️ `time` is not always sent.** On a real EQ4800 system no datum carries it at all. Anything
> that treats its absence as an error will misbehave — see `DECISIONS.md` §14, where doing exactly
> that silently emptied the chart on healthy hardware. Measure freshness against the inverter clock
> when present, and against your own fetch time when not.

### `POST /op/v0/device/history/query` — time series

```json
{ "sn": "…", "variables": [...], "begin": 1703548800000, "end": 1703635200000 }
```

Millisecond timestamps, **max 24 hours** per request. Omitting the range returns the last three
days. Used **once at startup** to backfill today's chart from local midnight; after that the chart
is built from the poller's own samples at no API cost.

### `POST /op/v0/device/report/query` — energy totals

```json
{ "sn": "…", "year": 2026, "month": 8, "day": 29, "dimension": "day",
  "variables": ["generation","feedin","gridConsumption","chargeEnergyToTal","dischargeEnergyToTal","PVEnergyTotal","loads"] }
```

`dimension` is `year` | `month` | `day`. Returns `[{variable, unit, values: number[]}]` — for
`day`, one entry per hour. Sum for the day's total. Calculated in the **plant's** timezone.

### `GET /op/v0/device/generation?sn=…` — generation summary

Returns `{ today, month, cumulative }` in kWh. One call for three headline figures.

### `GET /op/v0/device/battery/soc/get?sn=…` — minimum SOC

```json
{ "errno": 0, "result": { "minSoc": 10, "minSocOnGrid": 20 } }
```

Both are integer percentages, and **which one is in force depends on the inverter's state**:

| State | Floor | Why |
|---|---|---|
| on-grid (`runningState` 163) | `minSocOnGrid` | the pack is held back so a power cut has a reserve |
| off-grid (164) | `minSoc` | the grid is gone; that reserve is what is being spent |

This is the **read** half of a get/set pair. `battery/soc/set` exists and is deliberately not
implemented — see `DECISIONS.md`.

### `GET /op/v0/user/getAccessCount` — quota

Returns `{ total, remaining }` as **strings**. The authoritative quota figure; the local budget
counter is reconciled against it.

---

## Variables

From `GET /op/v0/device/variable/get` (the full list is large; these are the ones this project
uses). "ES" = available on energy-storage inverters, "GT" = grid-tied.

### Requested every poll — `real/query`

| Variable | Unit | Meaning | ES | GT |
|---|---|---|:-:|:-:|
| `pvPower` | kW | Total PV input power | ✓ | ✓ |
| `loadsPower` | kW | Total load power | ✓ | ✓ |
| `feedinPower` | kW | Power exported to grid | ✓ | ✓ |
| `gridConsumptionPower` | kW | Power drawn from grid | ✓ | ✓ |
| `generationPower` | kW | Total AC output power | ✓ | ✓ |
| `epsPower` | kW | EPS total output power | ✓ | ✓ |
| `SoC` | % | Battery state of charge | ✓ | ✗ |
| `SOH` | % | Battery state of health | ✓ | ✗ |
| `ResidualEnergy` | kWh | Remaining energy — **unreliable, see below** | ✓ | ✗ |
| `batChargePower` | kW | Battery charge power | ✓ | ✗ |
| `batDischargePower` | kW | Battery discharge power | ✓ | ✗ |
| `invBatPower` | kW | Inverter-side battery power | ✓ | ✗ |
| `batTemperature` | ℃ | Battery temperature | ✓ | ✗ |
| `ambientTemperation` | ℃ | Ambient temperature *(sic — the API misspells it)* | ✓ | ✓ |
| `runningState` | — | Running state, see the enum below | ✓ | ✓ |

### `runningState` values

**The codes start at 160, not 0 or 1.** Anything outside 160–170 is not a running state, and should
be surfaced as an unknown code rather than mapped to a plausible-looking label.

| Code | Meaning | | Code | Meaning |
|---:|---|---|---:|---|
| 160 | self-test | | 166 | permanent-fault |
| 161 | waiting | | 167 | standby |
| 162 | checking | | 168 | upgrading |
| 163 | **on-grid** — normal operation | | 169 | fct (factory self-test) |
| 164 | off-grid — running on backup | | 170 | illegal |
| 165 | fault | | | |

Implemented as `runningStateLabel()` in `web/src/format.ts`, which also assigns a severity:
`165`, `166` and `170` are faults; `164` is a notice (the grid is down and the house is on backup);
`163` and `167` are normal.

### ⚠️ `ResidualEnergy` is not remaining energy on every pack

Documented as "Remaining energy in battery" in kWh. **Measured against real hardware it can be
badly wrong.**

On an **EQ4800-L6 (27.96 kWh, one master + six slaves)** at 68% SOC:

| Source | Value |
|---|---|
| FoxESS app | **19.01 kWh** ( = 27.96 × 0.68, exactly ) |
| API `ResidualEnergy` | **26.9 kWh** ( = 96% of the pack, at 68% charge ) |

`SoC` agreed with the app, so `ResidualEnergy` is the variable at fault. The factor is ~1.41, which
is not a unit conversion, and what it actually represents on that firmware is unknown.

**Therefore:** when the pack capacity is known, compute stored energy as `capacity × SoC / 100` and
treat `ResidualEnergy` as diagnostic only. `BATTERY_CAPACITY_KWH` sets the capacity;
`residualDisagrees()` in `src/normalize.ts` flags the mismatch and `npm run probe` prints both.

### No per-cell temperatures

The OpenAPI exposes **no minimum or maximum cell temperature**. The only battery temperature is
`batTemperature`, a single pack-level figure. The FoxESS app *does* show a min-cell temperature, so
the two will legitimately differ — on the same system the app showed 12.4 ℃ min cell while
`batTemperature` reported 19.4 ℃. That is not a bug in either place; they are different
measurements. Nor is `ambientTemperation` room temperature: it is the inverter's own sensor, inside
a warm enclosure.

The other temperature variables (`boostTemperation`, `invTemperation`, `chargeTemperature`,
`dspTemperature`) are all inverter-internal, not battery.

### Sign conventions — read carefully

The API splits and signs battery power in a way that's easy to get backwards:

- **`invBatPower` is positive on DISCHARGE, negative on CHARGE.** (So is `invBatCurrent`.)
- `batChargePower` and `batDischargePower` are that same value split into two always-positive
  series: `batDischargePower` = `invBatPower` when positive, `batChargePower` = `|invBatPower|`
  when negative.
- Grid flow is likewise split into two positive series, `gridConsumptionPower` (import) and
  `feedinPower` (export), rather than one signed value.

`src/normalize.ts` collapses both back into single signed numbers, choosing **positive = charging**
for the battery (the intuitive reading, i.e. the *opposite* of `invBatPower`) and **positive =
importing** for the grid. See `DECISIONS.md`.

### Report variables — `report/query`

| Variable | Unit | Meaning |
|---|---|---|
| `generation` | kWh | Cumulative generation (AC out, affected by battery charge/discharge) |
| `PVEnergyTotal` | kWh | Total PV energy |
| `loads` | kWh | Load consumption |
| `feedin` | kWh | Total energy exported |
| `gridConsumption` | kWh | Total energy imported |
| `chargeEnergyToTal` | kWh | Total battery charge *(sic — the API's own capitalisation)* |
| `dischargeEnergyToTal` | kWh | Total battery discharge *(sic)* |

Note the API's spellings — `ambientTemperation`, `chargeEnergyToTal`, `dischargeEnergyToTal` — are
reproduced exactly as the API expects them. They are not typos in our code.

---

## Not used

- **OAuth2 / Client Credentials** (`/oauth2/token`, `/oauth2/client_token`) — for VPP integrations
  binding third-party devices. A personal API key is simpler and sufficient here.
- **All write endpoints** — `/device/battery/soc/set`, `/device/scheduler/set`,
  `/device/setting/set`, `/device/battery/forceChargeTime/set`, etc.
- **`/op/v0/ems/*`, `/op/v0/gw/*`, `/op/v0/heat/*`, `/op/v0/gmax/*`** — other product lines.
