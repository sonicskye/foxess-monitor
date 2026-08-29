# Using this data in a smart home

How to get your solar and battery figures out of this dashboard and into something that can **act**
on them — turn on the immersion heater when you're exporting, hold off the washing machine when the
battery is low, or just keep years of history.

Written to be read start-to-finish before you decide anything. No hub is required to begin.

---

## The one rule: don't add a second FoxESS integration

FoxESS allows **1440 API calls per day per inverter, shared across every client using your API key**.
Not per app — per inverter, in total.

This dashboard already uses **1276 of them**. If you install another FoxESS integration (for example
`foxess-ha` for Home Assistant) and point it at the same key, the two together will exhaust the
day's quota by mid-morning and **both will stop working** until midnight.

So: whatever you set up should read the data **from this dashboard**, not from FoxESS directly. That
costs nothing, because we've already paid for the call.

If you would rather use a dedicated integration instead of this one, that is a perfectly reasonable
choice — but then raise `POLL_REAL_SECONDS` here substantially, or stop this service, so the two are
not competing. `npm run probe` and the diagnostics panel (`d`) both show how much quota is left.

---

## What you already have

The dashboard serves everything as JSON on your network, updated every 90 seconds. Nothing needs to
be built for this — it is live right now:

```sh
curl http://<laptop-ip>:8080/api/snapshot
```

### The fields

| Path | Meaning |
|---|---|
| `snapshot.solarKw` | solar generation, kW |
| `snapshot.loadKw` | household consumption, kW |
| `snapshot.gridKw` | **signed**: positive importing, negative exporting |
| `snapshot.batteryKw` | **signed**: positive charging, negative discharging |
| `snapshot.soc` | battery charge, % |
| `snapshot.soh` | battery health, % |
| `snapshot.generationKw` | inverter AC output, kW |
| `snapshot.epsKw` | backup/EPS output, kW |
| `snapshot.batteryTempC` | battery pack temperature (not min-cell — see `API-NOTES.md`) |
| `snapshot.ambientTempC` | the *inverter's* ambient sensor, not room temperature |
| `snapshot.runningState` | 163 on-grid, 164 off-grid, 165 fault (full list in `API-NOTES.md`) |
| `snapshot.stale` | **true when the inverter has stopped reporting** — check this |
| `battery.capacityKwh` | pack size, kWh |
| `battery.storedKwh` | energy in the pack now |
| `battery.usableKwh` | energy above the reserve — what you can actually use |
| `battery.reservedKwh` / `battery.floorPercent` | the reserve the inverter will not discharge below |
| `totals.solarKwh` etc. | today's totals: `solarKwh`, `loadKwh`, `importKwh`, `exportKwh`, `batteryChargedKwh`, `batteryDischargedKwh` |
| `generation.monthKwh` / `cumulativeKwh` | month and lifetime generation |
| `quota.remaining` | API calls left today |

**Use `snapshot.stale` in any automation you write.** When the inverter drops off, the numbers stop
changing rather than going to zero — so an automation that trusts them blindly will happily act on a
reading from three hours ago.

---

## Option A — just log it (no hub, 5 minutes)

If you only want a record you can open in a spreadsheet later, you don't need any smart-home
software at all. One line in `crontab -e`:

```cron
*/5 * * * * curl -s http://localhost:8080/api/snapshot | python3 -c "import json,sys,datetime; d=json.load(sys.stdin); s=d['snapshot']; print(f\"{datetime.datetime.now().isoformat()},{s['solarKw']},{s['loadKw']},{s['gridKw']},{s['soc']}\")" >> ~/foxess-log.csv
```

Costs nothing, breaks nothing, and needs no new software.

Note the dashboard already keeps its own 5-minute-ish samples in `data/samples-YYYY-MM-DD.ndjson`
for **14 days** (`RETAIN_DAYS`). Raise that number if you just want longer history — that may be all
you need.

---

## Option B — Home Assistant

### What it is

Free, open-source home automation software that runs on a small always-on computer in your house.
Its purpose is to talk to devices from **different ecosystems** — Tuya, Zigbee, Z-Wave, Hue, and so
on — and let them work together, which they normally can't because each brand only speaks to its own
app.

**Your existing Tuya devices work with it.** There is an official Tuya integration (goes via Tuya's
cloud, needs a free Tuya IoT developer account) and a community one, LocalTuya, which talks to the
plugs directly on your network with no cloud at all.

### What it would let you do

Things neither the FoxESS app nor this dashboard can do, because neither can *act*:

- switch on the immersion heater or EV charger **only while exporting more than 2 kW**
- refuse to start a big appliance when the battery is below its reserve
- send a phone notification if the inverter reports a fault, or the battery drops under 20%
- keep years of history and graph it against temperature, tariff, or anything else

### What it costs

**It really wants its own machine.** The standard install (Home Assistant OS) takes over the whole
computer, and your Toshiba is already committed to being the wall display — a 4 GB Celeron running a
kiosk browser has little room to spare.

| | |
|---|---|
| Hardware | Raspberry Pi 4/5, or a used mini PC — roughly £60–120 |
| Software | free |
| Setup effort | an evening to get running; longer to learn |
| Ongoing | it is another thing to update and back up |

If you already have a NAS or a machine running Docker, Home Assistant Container can share it instead
of needing its own box.

### Connecting it to this dashboard

One HTTP call, many sensors. In Home Assistant's `configuration.yaml`:

```yaml
rest:
  - resource: http://192.168.1.50:8080/api/snapshot   # your laptop's IP
    scan_interval: 90                                  # matches our poll; no point going faster
    sensor:
      - name: "Solar power"
        value_template: "{{ value_json.snapshot.solarKw }}"
        unit_of_measurement: "kW"
        device_class: power
        state_class: measurement

      - name: "House load"
        value_template: "{{ value_json.snapshot.loadKw }}"
        unit_of_measurement: "kW"
        device_class: power
        state_class: measurement

      # Signed: positive = importing, negative = exporting.
      - name: "Grid power"
        value_template: "{{ value_json.snapshot.gridKw }}"
        unit_of_measurement: "kW"
        device_class: power
        state_class: measurement

      - name: "Battery charge"
        value_template: "{{ value_json.snapshot.soc }}"
        unit_of_measurement: "%"
        device_class: battery
        state_class: measurement

      - name: "Battery usable energy"
        value_template: "{{ value_json.battery.usableKwh }}"
        unit_of_measurement: "kWh"
        device_class: energy

      - name: "Solar today"
        value_template: "{{ value_json.totals.solarKwh }}"
        unit_of_measurement: "kWh"
        device_class: energy
        state_class: total_increasing

    binary_sensor:
      # Guard every automation with this.
      - name: "Inverter data stale"
        value_template: "{{ value_json.snapshot.stale }}"
        device_class: problem
```

`scan_interval: 90` matches our polling — asking more often just returns the same numbers, and
**costs no FoxESS quota either way**, because Home Assistant is reading us, not FoxESS.

An automation then looks like:

```yaml
automation:
  - alias: "Immersion heater on surplus export"
    trigger:
      - platform: numeric_state
        entity_id: sensor.grid_power
        below: -2            # exporting more than 2 kW
        for: "00:05:00"      # sustained, not a passing cloud gap
    condition:
      - condition: state
        entity_id: binary_sensor.inverter_data_stale
        state: "off"         # never act on a stale reading
    action:
      - service: switch.turn_on
        target:
          entity_id: switch.immersion_heater    # your Tuya plug
```

---

## Option C — MQTT

MQTT is a small messaging protocol that is the common language of home automation. One program
publishes values to a "broker"; anything else can subscribe. Home Assistant, Node-RED and openHAB
all speak it.

**This project does not publish MQTT today.** It is the natural thing to add if you want the data
pushed out rather than polled, and it would work with whatever hub you pick — but it needs a broker
running somewhere, which you generally get as part of installing Home Assistant. Ask and it can be
added; there is no point building it before there is something to publish to.

---

## Option D — Tuya directly (not recommended)

Tuya's cloud API is built to **read the state of devices Tuya already knows about, and send them
commands**. There is no supported way to simply post your own sensor readings into it.

Getting this data into Tuya means **pretending to be a Tuya device**:

1. register on the Tuya IoT Platform and create a "product"
2. define a datapoint schema for every value you want to send
3. implement their device protocol (Tuya Link SDK / MQTT) with provisioned device credentials
4. keep that working as their platform changes

That is a substantial piece of software, and the result sends readings from your laptop to Tuya's
cloud and back to a plug three metres away — with an internet outage breaking automations that never
needed to leave the house.

**If the goal is to use Tuya plugs with solar data, install Home Assistant and add Tuya to it.** You
get the same outcome, locally, without writing a device driver.

---

## Which to pick

| You want | Do this |
|---|---|
| A record to look at later | **Option A**, or just raise `RETAIN_DAYS` |
| Devices to react to your solar | **Option B** — Home Assistant, with your Tuya plugs added to it |
| Already have Node-RED or a broker | **Option C** — ask for MQTT publishing |
| To use Tuya's cloud as the hub | **Option D** — possible, but reconsider Option B first |

Whatever you choose, `/api/snapshot` is already there and nothing here needs to change to support
it. And whatever you choose, **do not point a second integration at your FoxESS key.**
