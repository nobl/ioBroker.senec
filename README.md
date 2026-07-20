![Logo](admin/senec.png)
# ioBroker.senec

[![NPM version](http://img.shields.io/npm/v/iobroker.senec.svg)](https://www.npmjs.com/package/iobroker.senec)
[![Downloads](https://img.shields.io/npm/dm/iobroker.senec.svg)](https://www.npmjs.com/package/iobroker.senec)
![Number of Installations (latest)](http://iobroker.live/badges/senec-installed.svg)
![Number of Installations (stable)](http://iobroker.live/badges/senec-stable.svg)
[![Known Vulnerabilities](https://snyk.io/test/github/nobl/ioBroker.senec/badge.svg)](https://snyk.io/test/github/nobl/ioBroker.senec)

[![NPM](https://nodei.co/npm/iobroker.senec.png?downloads=true)](https://nodei.co/npm/iobroker.senec/)

**Tests:** ![Test and Release](https://github.com/nobl/ioBroker.senec/workflows/Test%20and%20Release/badge.svg)

## SENEC adapter for ioBroker

[Dokumentation DE](docs/de/README.md) | [Documentation EN](docs/en/README.md)

Monitor and control your SENEC home battery storage system from ioBroker. The adapter connects via four independent data sources — use one or combine them for maximum coverage:

| Connector | Data source | Update speed | Key capabilities |
|-----------|------------|-------------|-----------------|
| **Local** | lala.cgi (LAN) | 10s real-time | Full BMS data, grid meter, wallbox, appliance control |
| **SENEC App API** | Cloud API | 6 min | Dashboard, measurements, system details |
| **mein-senec.de** | Web portal | 6 min | Measurements, emergency power, peak shaving, SG-Ready, sockets |
| **SENEC.Connect** | Azure API | 5 min | Battery & meter data |

### Built-in Dashboard

Access a full-featured dashboard at `http://<iobroker>:8082/senec/` — no extra adapters needed. Dark/light theme, 11 languages.

![Dashboard Overview](docs/en/media/dashboard-overview.png)

**Overview** — Live energy flow diagram with animated power paths, battery SOC gauge, operating mode, period totals with autarky. Live power curve chart with history backfill from InfluxDB/SQL/History. Event timeline showing today's warnings and errors.

**Battery** — State of health per pack, charge cycles, cell voltage heatmap (spot imbalance at a glance), temperatures.

**Charts** — Measurement history (hourly/daily/monthly/yearly) with comparison mode, stacked view, battery level overlay, data table, PNG export.

**System** — Grid quality (frequency, per-phase voltage/power/current), PV string details, wallbox info, feature flags, firmware versions.

**Control** — Force charge, appliance reboot, emergency power reserve, peak shaving, SG-Ready, switchable sockets, wallbox control. Available via Local and/or mein-senec.de.

**Logs** — Browse device logs by date, filter by level/category, live mode, download.

### Supported Systems

* Senec Home 4.0, 6.0, 8.0, 10.0 / Blei
* Senec Home 5.0, 7.5, 10.0, 15.0 / Lithium
* Senec Home V2 5.0, 7.5, 10.0
* Senec Home V2.1
* Senec.Home V3
* Senec.Home V4
* Senec Business 30.0 / Blei
* Senec Business V2 30.0 / Blei
* Senec Business 25.0 / Lithium
* Senec Business V2_2ph / Lithium
* Senec Business V2 3ph / Lithium
* ADS Tec
* OEM LG
* Solarinvert Storage 10.0 / Blei

Systems without a local web interface can be monitored using the API and/or Web connectors. Please contact the developer if you have input on additional system compatibility.

### Getting Started

See the [full documentation](docs/en/README.md) for installation, configuration, and feature details.

## Disclaimer
**All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal.**

### Deprecated / Removed states
* STATISTIC
* Display
* _calc (not relevant anymore since we lost STATISTIC)
* BAT1OBJ[2-4] 

## Donate
Maintenance of this adapter can be quite time consuming. If you wish to thank the author, please use these links:
[![WERO](https://img.shields.io/badge/WERO-8A2BE2)](https://share.weropay.eu/p/1/c/QzzqgSQcI3)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white)](https://www.paypal.me/gerbots)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/norblu)
[![GitHub Sponsor](https://img.shields.io/badge/Sponsor-GitHub-181717?logo=github&logoColor=white)](https://github.com/sponsors/nobl)

## Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
- External Sources: Add PV, consumer (wallbox, heat pump, etc.), and battery sources from other ioBroker adapters. Formula support for calculated values (e.g. V*A per phase). Integrate mode adds to SENEC totals, separate mode shows individual nodes in the energy flow diagram. Battery SOC and capacity support with time estimates. Dynamic diagram layout with summary nodes for multiple PV/battery sources.
- Fix: ValueTyping type flip-flop between string/number for states with physical units.

### 2.10.0 (2026-07-20)
- Dashboard: Live power curve on Overview tab — real-time SVG line chart with smooth monotone cubic interpolation. Shows PV, house, grid, battery, wallbox from any connector. Time windows 10m–24h, line toggles, pause, disable toggle. History adapter backfill on page load (InfluxDB, SQL, History). Source follows energy flow selector.
- Dashboard: Cell voltage heatmap on Battery tab — SVG grid with color-coded per-cell voltages across all modules, per-module delta indicators, and legend bar.
- Dashboard: Event timeline on Overview tab — 24h strip showing warnings, errors, and panics as colored markers with hover details. Auto-refreshes every 10 minutes.
- Dashboard: Source badges added to Cell Voltage, Cycles, Grid Quality, and PV-Strings cards.
- Dashboard: Async loading — energy flow renders immediately, live chart history and event timeline load independently.
- Fix: Energy flow path allocation rewritten with proper priority-based logic (PV→House→Battery→Grid). Fixes missing flows in multi-source scenarios (e.g. PV→Grid while Battery→House, or Battery→Grid while PV active).
- Debug & Logging: Per-connector matrix for all debug options (Local, API, mein-senec, Connect). Show polling, request/response logging, queue diagnostics, and diagnostic states can now be toggled independently per connector.
- Web connector now has its own `web_debug_states` and `web_debug_log` options (previously shared with API).
- Fix: jsonConfig staticText responsive attributes (W5508).
- Documentation: Complete rewrite of README, English and German user guides with screenshots. Dashboard `?lang=` URL parameter for language override.

### 2.9.3 (2026-07-17)
- Fix: jsonConfig staticText missing size attributes (E5507)

### 2.9.2 (2026-07-16)
- Fix: API energy flow discovery picked wrong Anlagen ID when stale states existed. Now prefers ID with Dashboard data.
- Fix: Web AllTime measurements now update every slow tier cycle (default 24h) instead of only once per year.
- Fix: Web poll loop could die silently if measurement polling threw an unhandled error.
- Fix: Numeric string precision loss in ValueTyping (e.g. DEVICE_ID). Added `stringtype` support.
- Dashboard: Grid quality card redesigned as table layout (Frequency, Total Power, per-phase Voltage/Power/Current). Support for EnFluRi 2 with automatic detection (non-zero voltage).
- Dashboard: Battery tab — module status counts (active/charging/discharging), cycles & lifetime energy table per pack, per-pack voltage and current.
- Dashboard: System tab — PV string details (MPP power/voltage/current), wallbox info (EV connected, smart charge, per-phase current), operating hours, installation date, installer contact.
- Dashboard: Energy flow — live autarky badge (API native or calculated), week + lifetime autarky in period totals. Battery capacity auto-detected from API or Web (config as fallback). Fixed flow paths to show actual source/destination (e.g. battery→grid instead of PV→grid when PV is idle). Power labels on all flow paths. Tab switch now re-renders with latest state values.
- Dashboard: Measurement charts — battery level (%) line overlay with comparison support and data table.
- Web: Poll battery state (`getaccustate.php`) on medium tier — voltage, current, capacity, type, history.
- Web: Secondary plant discovery and measurement polling. Control via `control.Plants.{id}.poll`.
- AdaptiveRequestQueue: Optional per-request retry with configurable max attempts and logging.
- Simplified `state_attr.js` from ~7000 to ~1080 lines (stripped redundant defaults, added type header comment).

### 2.9.1 (2026-07-16)
- Fix: jsonConfig validation error (`collapsed` not allowed on panel type)
- Fix: Welcome screen tile color changed from green to SENEC blue

### 2.9.0 (2026-07-15)
- Web dashboard: Built-in dashboard accessible at `http://<iobroker>:8082/senec/` via ioBroker.web extension. Shows on the ioBroker.web welcome page. Dark/light theme toggle. Internationalization with 11 languages.
- Energy flow diagram: Live SVG visualization of power flow between PV, battery, grid, house, and wallbox. Animated curved flow paths with power-proportional thickness. Battery SOC gauge with fill level indicator. Operating mode badge (color-coded). Battery time estimates (until empty/full). Multi-source support with manual override (Local > API > Web). Period totals (today/month/year) with self-sufficiency display. Last update timestamp from active connector.
- Measurement charts: Bar charts for hourly (today), daily (month), and monthly (year) energy data. Toggle individual measurement types. Stacked production/consumption view. Period comparison (yesterday, previous month, selectable year). Data source selector (Auto/API/Web). Auto-update mode. Data table view. PNG image export. Today view trims to hours with data.
- Battery health tab: System and per-pack SOH with color-coded health indicators. Module count. Separate temperature card (overall, per-module, per-module cell temps). Separate voltage card (overall min/max with delta, per-module cell voltages with delta). Data from Local (BMS) or API (SystemDetails) with source indicator badges.
- System tab: Grid quality (frequency, per-phase voltage/power/current, phase skew warning). Feature flags from all connectors with mismatch detection. System details (product, firmware, GUI/NPU version, inverter state, casing/MCU/battery/inverter temperatures). Source indicator badges on all metrics.
- Control panel: Force battery charging (toggle), appliance reboot (with confirmation), emergency power reserve, peak shaving (mode-dependent fields), SG-Ready (enable + thresholds), switchable sockets (per-socket mode with auto-threshold settings, name editing via web), wallbox control (smart charge, current, intercharge). All controls check connector availability and show warnings. Apply button feedback with "Sent" confirmation. Config changes auto-detected.
- Appliance log viewer: Browse SENEC device logs by date with filterable table (Time, Level, Category, Message). Supports Info/Warning/Error/Panic levels with color-coded row highlighting. Newest entries first. Live mode auto-refreshes today's log (UTC-aware). Download raw log files.
- Per-connector connection states: New `info.localConnected`, `info.apiConnected`, `info.webConnected`, `info.connectConnected` states. Local polling now writes `info.lastPoll.HighPrio` and `info.lastPoll.LowPrio` timestamps.
- Accessibility: Semantic HTML, ARIA roles and attributes, keyboard navigation for tabs, focus indicators, screen reader support.
- State translations: Added system state 100 (SOX calibration), system types 20-21 (SENEC.Home V3 hybrid LFP), updated wallbox states with official SENEC names, added SYS_UPDATE.FSM_STATE and PWR_UNIT.TYPE translations. Fixed BATTERY_IMPORT/EXPORT and accuimport/accuexport naming.
- Admin settings: Collapsible control overview panel showing available controls per connector. Simplified control help texts. Battery capacity config field for manual input.

### [Former Updates](CHANGELOG_OLD.md)

## License
MIT License

Copyright (c) 2020-2026 Norbert Bluemle <github@bluemle.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
