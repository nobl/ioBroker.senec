![Logo](admin/senec.png)
# ioBroker.senec

[![NPM version](http://img.shields.io/npm/v/iobroker.senec.svg)](https://www.npmjs.com/package/iobroker.senec)
[![Downloads](https://img.shields.io/npm/dm/iobroker.senec.svg)](https://www.npmjs.com/package/iobroker.senec)
![Number of Installations (latest)](http://iobroker.live/badges/senec-installed.svg)
![Number of Installations (stable)](http://iobroker.live/badges/senec-stable.svg)
[![Known Vulnerabilities](https://snyk.io/test/github/nobl/ioBroker.senec/badge.svg)](https://snyk.io/test/github/nobl/ioBroker.senec)

[![NPM](https://nodei.co/npm/iobroker.senec.png?downloads=true)](https://nodei.co/npm/iobroker.senec/)

**Tests:** ![Test and Release](https://github.com/nobl/ioBroker.senec/workflows/Test%20and%20Release/badge.svg)

## senec adapter for ioBroker

[Dokumentation DE](docs/de/README.md)<br>
[Documentation EN](docs/en/README.md)

Initially targeted at the Senec Home V2.1 System.
In the Senec.Home system, only selected values can be changed by the adapter. Use of this functionality is at your own risk and must be activated manually in the configuration beforehand.
Senec currently also no longer provides a reliable way to influence peak shaving via the web interface. For this purpose, mein-senec.de must be used.
Whether other systems (e.g. V3) also work with it depends on whether they are also based on lala.cgi and provide the same JSON information.
Even with integration into the Senec.Clound it is not guaranteed that the data can still be retrieved via the web interface (for this please report your experiences).

Adapter supports local polling via lala.cgi and polling via Web API.

Systems that might work:
* Senec Home 4.0,  6.0, 8.0, 10.0 / Blei
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

SENEC Systems that don't provide a local webinterface might be monitored by using the API functionality only. Please contact the developer if you have any input on this.

## Disclaimer
**All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal.**

## Usage
You can find a description of some sample states in documentation. All states of this adapter are read-only states unless they are control-states to control the appliance.
   
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
- Web dashboard: Built-in dashboard accessible at `http://<iobroker>:8082/senec/` via ioBroker.web extension. Shows on the ioBroker.web welcome page.
- Energy flow diagram: Live SVG visualization of power flow between PV, battery, grid, house, and wallbox. Animated curved flow paths with power-proportional thickness. Battery SOC gauge with fill level indicator.
- Multi-source support: Energy flow auto-selects the best available data source (Local > API > Web) with manual override. Normalizes data from all connectors into a unified format.
- Today's energy totals: PV generation, consumption, grid import/export, battery charge/discharge, and wallbox energy displayed below the flow diagram (kWh).
- Per-connector connection states: New `info.localConnected`, `info.apiConnected`, `info.webConnected`, `info.connectConnected` states for individual connector status monitoring.
- Appliance log viewer: Browse SENEC device logs by date with filterable table (Time, Level, Category, Message). Supports Info/Warning/Error/Panic levels with color-coded row highlighting. Live mode auto-refreshes today's log (UTC-aware). Download raw log files.

### 2.8.4 (2026-07-13)
- Web measurements: Measurement history (today, yesterday, monthly, yearly, AllTime) and autarky can now be polled from mein-senec.de. Data appears under `_meinsenec.Measurements` and `_meinsenec.Autarky`. Enable in adapter settings with "Poll measurement history". Optional 5-minute detail data with time-based keys for today/yesterday (creates ~3,500 additional states).
- Web request queue: All mein-senec.de requests now use an AdaptiveRequestQueue for rate-limiting. Configurable concurrency and min request interval in adapter settings.
- API/Web request interval: Minimum time between requests is now configurable for both API and web connectors (API previously hardcoded at 400ms).
- User-Agent settings moved from SENEC App API tab to SENEC Account tab — now applies to all connectors.
- Queue diagnostics cleanup: Diagnostics states for both API and web queues are now automatically cleaned up when debug states are disabled.

### 2.8.3 (2026-07-12)
- Active measurement periods (current year, current month, today) no longer skip re-fetch — frequency is now fully controlled by the configured tier intervals
- AllTime history now tracks a `last updated` timestamp

### 2.8.2 (2026-07-09)
- removed v2.8.0 from documentation - it never was released

### 2.8.1 (2026-07-09)
- Housekeeping
- Code optimizations
- Log messages now include connector prefix ([API], [Local], [Web], [Connect]) for easier filtering and debugging

### 2.7.0 (2026-07-07)
- SENEC Account tab: Shared credentials (email, password, TOTP) moved to a dedicated tab, always visible regardless of which cloud features are enabled.
- mein-senec.de controls: Emergency power reserve, peak shaving (mode, capacity limit, end time), and SG-Ready settings can now be controlled via mein-senec.de. Controls appear under `control.EmergencyPower`, `control.PeakShaving`, and `control.SGReady`. Enable in adapter settings under Appliance Control.
- Switchable socket control via mein-senec.de: Sockets can now be controlled via mein-senec.de web portal in addition to local lala.cgi. Unified control datapoints (Mode: Off/On/Auto, thresholds, durations, switch-on time) work with both connectors. A force override option is available for systems where socket capability is not detected.
- Connector-based control routing: Appliance Control tab restructured with per-connector consent checkboxes and per-feature connector dropdowns (Off/Local/API/Web). Only one connector per feature to avoid conflicts. Warning messages shown when a selected connector is not enabled.
- Independent control gates: Web, API, and local controls each have independent gates in state change handling. API controls no longer require local lala.cgi connection. Fixed plant number 0 falsy bug.
- API error handling: All mein-senec.de POST handlers check HTTP response status and log error messages from the API.
- Peak shaving fixes: Capacity limit uses correct field (peakShavingCapacityLimitInPercent), capped at 90%. End time split into EndHour/EndMinute fields. UTC timestamp construction for correct time handling with SENEC API.
- Debug & Logging tab: Debug settings moved to a dedicated tab applying to all connectors. Request/response logging now includes mein-senec.de traffic.

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
