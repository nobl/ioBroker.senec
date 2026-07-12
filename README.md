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

### 2.6.0 (2026-07-06)
- TOTP/2FA: If your mein-senec.de account requires two-factor authentication, you can now enter your TOTP secret (the base32 key from your authenticator app setup) in the adapter settings. The adapter will automatically generate login codes — no manual interaction needed.
- Switchable sockets: If your SENEC system has switchable sockets configured, you can now control them via `control.Sockets` datapoints. Enable in adapter settings under active appliance control.
- Section discovery: The adapter now queries the device at startup to discover available data sections. New sections are automatically added to polling, and unavailable sections are removed. Check `info.discoveredSections` and `info.unavailableSections` for details.
- Added support for AMPACE battery module data (cell temperatures, alarm/fault/warning states).
- System details: Battery SOH, inverter state/temperatures, module states, casing temperature, warranty info and more are now polled from the SENEC app API (hourly).
- Abilities: Installed feature packages (MOBILITY, PEAK_SHAVING, SG_READY, etc.) are queried at startup.
- Wallbox control (experimental): If your SENEC system has wallboxes, you can control charging current, smart charge, and intercharge via `control.Wallbox` datapoints. Enable in adapter settings. Please report your experience to the developer.
- Wallbox cloud API (experimental): Wallbox discovery and measurements via SENEC App API. Wallbox data is polled on all tiers (dashboard/details/heavy) including AllTime history rebuild. Cloud-based wallbox control is being worked on. Shoutout to [marq24](https://github.com/marq24/ha-senec-v3) for the groundwork on wallbox API integration in the HA community.
- New API endpoints: System status, data availability, online state, and forecast charging settings.
- API polling resilience: Each API endpoint is now polled independently via `Promise.allSettled` — one failing endpoint no longer blocks others in the same tier. Per-endpoint last-poll timestamps visible under `_api.info.lastPoll.*`.
- SENEC.Connect: Support for the official SENEC.Connect API (paid subscription). Provides battery, meter, and wallbox data via a simple subscription key. Configure in the new SENEC.Connect tab in adapter settings. Note: At this point SENEC.Connect appears to only be available for V4/E4 systems. Older systems (V2/V3) may return empty data.
- API paths updated to June 2026 format for future compatibility.

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
