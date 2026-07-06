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
Here you can find a description of the states (list is incomplete) and how to use them. All states of this adapter are read-only states.

### Example States (States differ per System and Version)

#### Channel: info

* info.connection

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *Read-only boolean which is true if the adapter is connected to the senec system.*
   
#### Channel: _api
This channel contains values polled from SENEC App-API. 

   
#### Channel: BMS
   
* MODULES_CONFIGURED

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the number of modules currently configured in the system.*
   
* MODULE_COUNT

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the number of modules currently known the system (incl. non-configured).*
   

#### Channel: ENERGY
   
* GUI_BAT_DATA_CURRENT

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the battery's current in Amps.*
   
* GUI_BAT_DATA_FUEL_CHARGE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the current level of your battery system in %.*
   
* GUI_BAT_DATA_VOLTAGE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the battery's current voltage in volt.*
   
* GUI_BAT_DATA_POWER

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents how much power is coming from / going into the battery in Watts. Negative values are discharging.*
   
* GUI_CHARGING_INFO

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *Read-only boolean, which represents if the battery is currently charging.*
   
* GUI_GRID_POW

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the power currenty coming from / going into the grid in Watts. Negative values are sending into the grid.*
   
* GUI_HOUSE_POW

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the power in Watts currently consumed by the house.*
   
* GUI_INVERTER_POWER

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the current power supplied by your PV system.*
   
* STAT_HOURS_OF_OPERATION

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, detailing the system's uptime in hours.*
   
* STAT_STATE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the system's state.*
   
* STAT_STATE_Text

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |string|R|

   *Read-only string, which represents the system's state in human readable format (sorry - we only have the german states from senec).*
     
   
#### Channel: SYS_UPDATE

* NPU_IMAGE_VERSION

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, representing the Revision NPU-IMAGE*

* NPU_VER

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, representing the Revision NPU-REGS*

* UPDATE_AVAILABLE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *boolean-value which is true if there is an update available (Updates happen automatically and are scheduled by SENEC).*
   
   
#### Channel: WIZARD

* APPLICATION_VERSION

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |string|R|

   *Read-only text, representing the Revision MCU*

* CONFIG_LOADED

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *boolean-value which is true if configuration is loaded. This being false is very unlikely and it shouldn't persist as false.*
   
* INTERFACE_VERSION

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |string|R|

   *Read-only text, representing the Revision GUI*
   
* SETUP_NUMBER_WALLBOXES

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which designates how many wallboxes are configured in the system.*
   
* SETUP_WALLBOX_SERIAL[0..3]

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which designates the number of wallbox [0..3]. This is only available on systems with configured wallboxes.*
   
   
### Deprecated / Removed 
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
- TOTP/2FA: If your mein-senec.de account requires two-factor authentication, you can now enter your TOTP secret (the base32 key from your authenticator app setup) in the adapter settings. The adapter will automatically generate login codes — no manual interaction needed.
- Switchable sockets: If your SENEC system has switchable sockets configured, you can now control them via `control.Sockets` datapoints. Enable in adapter settings under active appliance control.
- Section discovery: The adapter now queries the device at startup to discover available data sections. New sections are automatically added to polling, and unavailable sections are removed. Check `info.discoveredSections` and `info.unavailableSections` for details.
- Added support for AMPACE battery module data (cell temperatures, alarm/fault/warning states).
- System details: Battery SOH, inverter state/temperatures, module states, casing temperature, warranty info and more are now polled from the SENEC app API (hourly).
- Abilities: Installed feature packages (MOBILITY, PEAK_SHAVING, SG_READY, etc.) are queried at startup.
- Wallbox control (experimental): If your SENEC system has wallboxes, you can control charging current, smart charge, and intercharge via `control.Wallbox` datapoints. Enable in adapter settings. Please report your experience to the developer.
- API paths updated to June 2026 format for future compatibility.

### 2.5.5 (2026-07-06)
- Add TOTP/2FA support for SENEC API login (configure TOTP secret in adapter settings)
- Replace plain setTimeout/clearTimeout with adapter-managed timers
- Dependency updates

### 2.5.4 (2026-05-27)
- Adapter requires node.js >= 22 now
- Minor fixes
- Dependency updates

### 2.5.3 (2026-04-13)
- Clamping end-dates to current time if they are in the future to avoid issues with API
- Dependency updates
- Updated iobroker\testing-action-* versions

### 2.5.2 (2026-03-31)
- Rewrote AllTime History Rebuild: We should now be able to rebuild AllTime History even if the senec server struggles with timeouts. Warning! Rebuild will take considerable time now depending on the server. Current state of rebuild will be reported to log (info).
- You will now need to supply the installation year of your appliance upon AllTime History rebuild if you don't want empty yearly folders in the measurements path for yours you don't have data.
- More comprehensive logging on what is being polled from API.
- Better debug-logging for polling

### 2.5.1 (2026-03-31)
- Increased default API poll interval to 6 minutes. This appears to be causing less issues with the server than 5 minutes.
- You can now define different polling intervals for dashboard (frequently), details (usually hourly and daily information), heavy (for everything else that usually is done per month or year).<br>Please be careful with high frequency polling as this can and will lead to problems and the senec server will stop responding to your requests. Longer delays between polls are preferred.
- Dependency updates
- Code optimizations

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
