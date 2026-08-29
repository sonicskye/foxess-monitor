# Runbook

Operating the monitor on the laptop. For what the project is, see [`../README.md`](../README.md);
for why it is built this way, [`DECISIONS.md`](DECISIONS.md).

---

## First install

Node ≥ 20.6 is the only requirement.

```sh
sudo useradd --system --create-home --home-dir /opt/foxess-monitor foxess
sudo -u foxess git clone <your-repo> /opt/foxess-monitor
cd /opt/foxess-monitor

sudo -u foxess npm ci
sudo -u foxess cp .env.example .env
sudo -u foxess "${EDITOR:-nano}" .env        # set FOXESS_API_KEY and TZ

# The key is a live credential — it can change inverter settings.
sudo chmod 600 .env
sudo chown foxess:foxess .env

sudo -u foxess npm run build
sudo -u foxess npm run probe                 # 3 API calls; confirms the credentials work
```

Then the service:

```sh
sudo cp deploy/foxess-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now foxess-monitor
journalctl -u foxess-monitor -f
```

At startup it prints the projected daily call count. **If the projection exceeds
`DAILY_CALL_BUDGET` the process refuses to start** and names the setting to change — that is
working as intended, not a bug.

### The kiosk display

Add `deploy/kiosk.sh` to your desktop session's autostart. On a minimal install with LXDE/Openbox:

```sh
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/foxess-kiosk.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=FoxESS Kiosk
Exec=/opt/foxess-monitor/deploy/kiosk.sh
X-GNOME-Autostart-enabled=true
EOF
```

The script waits for `/healthz` before opening the browser, so a slow boot doesn't show an error
page, and disables screen blanking via `xset`.

---

## Daily use

| Key | Does |
|---|---|
| `d` | diagnostics — quota, job health, recent API calls |
| `t` | swap the chart for its data table |
| `esc` | close diagnostics |

The theme button follows the system light/dark setting until you click it, after which your choice
sticks.

Other devices on your network can view it at `http://<laptop-ip>:8080` as long as `HOST=0.0.0.0`.
Set `HOST=127.0.0.1` to restrict it to the laptop.

---

## Where things are

| | |
|---|---|
| Logs | `journalctl -u foxess-monitor` |
| API call audit | `data/api-calls-YYYY-MM-DD.ndjson` |
| Chart samples | `data/samples-YYYY-MM-DD.ndjson` |
| Budget counter | `data/budget.json` |
| Config | `.env` |

Sample and audit files are pruned to `RETAIN_DAYS` (14 by default).

---

## Diagnosing

### The display says "not live"

The inverter hasn't reported for over 10 minutes. The app is fine; the inverter or its connection
is not. Check the inverter's own network link — this is usually a WiFi dropout or a dongle reboot,
and it clears on its own. The dashboard deliberately desaturates and shows the age rather than
presenting old numbers as current.

```sh
journalctl -u foxess-monitor | grep stale     # logged once on the way out, once on the way back
```

### The quota is running out

Press `d`, or:

```sh
curl -s localhost:8080/api/diagnostics | python3 -m json.tool | head -30
```

Count today's actual calls and see what spent them:

```sh
wc -l data/api-calls-$(date +%F).ndjson
python3 -c "
import json,collections,sys
c=collections.Counter()
for line in open(sys.argv[1]):
    c[json.loads(line)['path']] += 1
for path,n in c.most_common(): print(f'{n:5d}  {path}')
" data/api-calls-$(date +%F).ndjson
```

If the count is higher than the projection, something is calling the API besides the schedule —
most likely a second copy of the service, or another client sharing the same API key. FoxESS
counts per inverter across *all* clients, so a Home Assistant integration on the same key is
spending the same 1440.

To use less: raise `POLL_REAL_SECONDS` (90 → 120 saves 240 calls/day) or `POLL_TOTALS_SECONDS`.

### Everything returns errno 40256

The signature or the key is wrong. In order of likelihood:

1. `FOXESS_API_KEY` is wrong or has been regenerated in FoxESS Cloud.
2. The signature separator was changed from the literal `\r\n` to real CRLF — see
   [`DECISIONS.md` §1](DECISIONS.md). `npm test` catches this.
3. The system clock is badly wrong. The timestamp is part of the signature.

```sh
timedatectl status         # check the clock
npm run probe              # 3 calls, prints the exact failure
```

### errno 40400

Rate limited. The budget backs off automatically (60s → 300s → 900s) and resumes. If it persists,
the day's quota is spent — the display will resume at local midnight. Check for a second client on
the same key, as above.

### The chart has a gap

That is real: the gap is when no samples were recorded, because the inverter was offline or the
service was down. Gaps are drawn as breaks rather than lines across the missing hours, so what you
see is what happened.

### The page shows "Frontend not built yet"

```sh
sudo -u foxess npm run build
sudo systemctl restart foxess-monitor
```

### The service won't start

```sh
systemctl status foxess-monitor
journalctl -u foxess-monitor -n 50
```

A configuration problem prints the whole list of what is wrong and exits 2 without retrying. A port
clash prints a plain message naming the port. If it hits the restart limit, `systemctl reset-failed
foxess-monitor` after fixing the cause.

---

## Updating

```sh
cd /opt/foxess-monitor
sudo -u foxess git pull
sudo -u foxess npm ci
sudo -u foxess npm run build
sudo -u foxess npm test          # should be green before restarting
sudo systemctl restart foxess-monitor
```

Restarting is cheap: the budget counter is on disk so it isn't reset, and one `history/query` call
rebuilds today's chart.

---

## Changing the polling schedule

Edit `.env`, then restart. The startup validator does the arithmetic and refuses anything that
would exceed the budget.

Useful figures, all per inverter per day:

| `POLL_REAL_SECONDS` | live calls/day | with 10-min totals | fits 1440? |
|---:|---:|---:|:--|
| 60 | 1440 | 1752 | no — 1440 alone is the whole ceiling |
| 75 | 1152 | 1464 | no |
| **90** | **960** | **1272** | **yes — the default** |
| 120 | 720 | 1032 | yes |
| 300 | 288 | 600 | yes |

`IDLE_POLL_SECONDS` takes over when no browser has been connected for `IDLE_SLOWDOWN_SECONDS`, so
closing the kiosk lid genuinely saves quota.

---

## Working on it without spending quota

```sh
FOXESS_MOCK=1 MOCK_OFFSET_HOURS=9 npm run dev
```

Serves a synthetic day and makes **zero** API calls. `MOCK_OFFSET_HOURS` shifts the simulated clock
so you can look at midday export or evening discharge instead of whatever hour it happens to be.
