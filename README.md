# <img src="admin/senec.png" width="36" align="top" alt=""> ioBroker.senec

[![NPM version](http://img.shields.io/npm/v/iobroker.senec.svg)](https://www.npmjs.com/package/iobroker.senec)
[![Downloads](https://img.shields.io/npm/dm/iobroker.senec.svg)](https://www.npmjs.com/package/iobroker.senec)
![Number of Installations (latest)](http://iobroker.live/badges/senec-installed.svg)
![Number of Installations (stable)](http://iobroker.live/badges/senec-stable.svg)
[![Known Vulnerabilities](https://snyk.io/test/github/nobl/ioBroker.senec/badge.svg)](https://snyk.io/test/github/nobl/ioBroker.senec)

[![NPM](https://nodei.co/npm/iobroker.senec.png?downloads=true)](https://nodei.co/npm/iobroker.senec/)

**Tests:** ![Test and Release](https://github.com/nobl/ioBroker.senec/workflows/Test%20and%20Release/badge.svg)

## SENEC adapter for ioBroker

[Dokumentation DE](docs/de/README.md) | [Documentation EN](docs/en/README.md)

> [!IMPORTANT]
> ### 🔎 Wanted: testers for the SENEC.Connect connector
>
> SENEC.Connect is the newest of the four connectors, and it is the one I have the least real-world data for — I cannot see what your subscription returns. **If SENEC.Connect reports anything at all for your account, please get in touch:** in the [ioBroker forum thread](https://forum.iobroker.net/topic/30620/neuer-adapter-senec-home-adapter) or via a [GitHub issue](https://github.com/nobl/ioBroker.senec/issues).
>
> Especially valuable:
> - **accounts holding more than one system** — a replaced appliance, or two systems at one address;
> - responses containing **more than `battery` and `meter`**, for instance `evse` (wallbox) or `bessNameplate`;
> - anything the adapter logs as `REPORT_TO_DEV`.
>
> The most useful thing you can send is the raw response: switch on *Log requests and responses* under the SENEC.Connect debug settings, set the log level to debug, and copy what the adapter writes out. **Please replace serial numbers and system ids with `***` before posting** — the rest is what matters.

Your SENEC system knows a great deal about itself. This adapter brings all of it into ioBroker — down to individual cell voltages and per-phase grid quality — and comes with a dashboard you do not have to build.

![Dashboard Overview](docs/en/media/dashboard-overview.png)

That screenshot is not a vis project someone assembled. It ships with the adapter, needs no extra adapters or widgets, and is running as soon as the instance is. Dark and light theme, 11 languages, usable on a phone.

### Four Ways In

The appliance answers on your own network, and SENEC runs three cloud services. The adapter speaks all four, independently.

**The local connector needs nothing but an IP address.** No account, no credentials, no request ever leaving your network — that is where this adapter started and it still works that way on its own. The cloud connectors are there when you want the measurement history and portal features that only exist online, or when your appliance has no local interface to talk to.

| Connector | Data source | Update speed | Key capabilities |
|-----------|------------|-------------|-----------------|
| **[Local](docs/en/README.md#local-connection-lalacgi)** | lala.cgi (LAN) | 10s real-time | Full BMS data, grid meter, wallbox, appliance control |
| **[SENEC App API](docs/en/README.md#senec-app-api)** | Cloud API | 6 min | Dashboard, measurements, system details |
| **[mein-senec.de](docs/en/README.md#mein-senecde)** | Web portal | 6 min | Measurements, emergency power, peak shaving, SG-Ready, sockets |
| **[SENEC.Connect](docs/en/README.md#senecconnect)** | Azure API | 5 min | Battery & meter data |

Replaced your appliance? Both systems stay on your mein-senec.de account, and the adapter finds [all of them](docs/en/README.md#additional-systems-on-the-account) — so the old one's history stays reachable next to the new one's live data.

One is enough to get started. Combining them is where it gets interesting: the local connection gives ten-second resolution and the deepest detail, while the cloud services hold years of measurement history and features that exist nowhere else — emergency power reserve, peak shaving, SG-Ready, switchable sockets. And if one source is down, or your appliance has no local interface at all, the others carry on regardless.

### Built-in Dashboard

**[Overview](docs/en/README.md#overview-tab)** — Live energy flow diagram with animated power paths, battery SOC gauge, operating mode, period totals with autarky. Event timeline showing today's warnings and errors.

**[Live power curve](docs/en/README.md#overview-tab)** — Drag through history and pinch to zoom, from a five-minute window out to thirty days, on a desktop or a tablet. If you log the power states with InfluxDB, SQL or History, the chart backfills from them and you can pan back through everything you have recorded.

![Live power curve](docs/en/media/dashboard-live-chart.png)

**[Battery](docs/en/README.md#battery-tab)** — State of health per pack, charge cycles, cell voltage heatmap (spot imbalance at a glance), temperatures.

![Cell voltage heatmap](docs/en/media/dashboard-heatmap.png)

**[Charts](docs/en/README.md#charts-tab)** — Measurement history (hourly/daily/monthly/yearly) with comparison mode, stacked view, battery level overlay, data table, PNG export.

![Measurement history](docs/en/media/dashboard-charts-year.png)

**[System](docs/en/README.md#system-tab)** — Grid quality (frequency, per-phase voltage/power/current), PV string details, wallbox info, feature flags, firmware versions.

**[Control](docs/en/README.md#control-tab)** — Force charge, appliance reboot, emergency power reserve, peak shaving, SG-Ready, switchable sockets, wallbox control. Available via Local and/or mein-senec.de.

**[Logs](docs/en/README.md#logs-tab)** — Browse device logs by date, filter by level/category, live mode, download.

**[Statistics](docs/en/README.md#statistics-tab)** — Browse the weekly 5-minute exports mein-senec.de keeps, going back years. Filter by day, switch between hourly and 5-minute resolution, chart or table, and export what you select.

### [External Energy Sources](docs/en/README.md#external-sources)

Integrate third-party PV inverters, consumers (wallbox, heat pump, etc.), and batteries from other ioBroker adapters into the SENEC dashboard. Values can be mapped directly from states or calculated via formulas (e.g. `{voltage.state} * {current.state}`). External sources appear in the energy flow diagram and live power chart — either added to SENEC totals or shown as separate nodes.

### Built to Keep Running

An adapter polling a battery every ten seconds runs unattended for years, so most of the work is in the parts you never see.

**It validates the connection to your appliance.** Local polling is HTTPS, and the certificate chain is verified against the CA you upload or one the adapter fetches from the portal for you. Where no CA can be obtained, the adapter falls back to recording the appliance's certificate fingerprint on first contact and warning you whenever it changes — continuity monitoring rather than full verification, chosen so a legitimate certificate change never leaves you disconnected. [How it works](docs/en/README.md#tls-certificate-validation)

**It backs off instead of hammering.** Cloud requests run through a queue that watches success rates, widens the gap between requests when the server rate-limits or times out, and narrows it again once things recover.

**It recovers on its own.** A failed poll does not end polling. Connectors retry with growing delays and pick up where they left off, and `info.connectionStatus` tells you at a glance which sources are currently live.

**It can rebuild what it missed.** The App API connector can reconstruct lifetime measurement history from scratch, working backwards year by year in the background. [History rebuild](docs/en/README.md#history-rebuild)

### Supported Systems

Practically every SENEC storage system works: the Home range from the early lead-acid and lithium
models through V2, V2.1 and V3, the current V4 | P4 | E4 generation, the Business models, and the
partner variants ADS Tec, OEM LG and Solarinvert.

Systems with a local web interface can use all four connectors. Those without one — the V4
generation among them — work through the SENEC App API, mein-senec.de and SENEC.Connect. Which
data points appear varies by model.

See the [full list of models](docs/SUPPORTED_SYSTEMS.md) to find your system by name.

### Requirements

- ioBroker running on Node.js 22 or newer
- For the local connector: the SENEC appliance reachable on your network, and its IP address
- For the cloud connectors: a mein-senec.de account
- For the dashboard: the ioBroker.web adapter (most installations already have it)

### Quick Start

Configure **at least one** connector on a new instance — you do not need all four, and you can add the others later.

**Local, for real-time data.** Open the *[Local Connection](docs/en/README.md#local-connection-lalacgi)* tab and enter the appliance's IP address. That is the whole setup. This connector polls every 10 seconds and provides the most detail: full battery management data, per-phase grid values, wallbox information and appliance control.

**Cloud, if the appliance has no local web interface** (the V4 generation, for example) **or you would rather not poll it directly.** Enter your mein-senec.de credentials in the *[SENEC Account](docs/en/README.md#senec-account)* tab, then enable the *[SENEC App API](docs/en/README.md#senec-app-api)* or *[mein-senec.de](docs/en/README.md#mein-senecde)* connector. Both use the same credentials, and both support accounts with [two-factor authentication](docs/en/README.md#two-factor-authentication-2fa). Data arrives every few minutes rather than in real time.

Once an instance is running, the dashboard is at `http://<your-iobroker>:8082/senec/`. Running more than one system? Create an instance per system — each dashboard follows its own instance. States appear under `senec.0` — the [state reference](docs/en/README.md#state-reference) lists them all — and can be logged with any history adapter.

Beyond that: [every setting explained](docs/en/README.md#configuration), the [complete state reference](docs/en/README.md#state-reference), [control features](docs/en/README.md#appliance-control) and [troubleshooting](docs/en/README.md#troubleshooting).

### Reporting a Problem

For questions, setups and comparing notes with other users, there is a [dedicated thread in the ioBroker forum](https://forum.iobroker.net/topic/30620/neuer-adapter-senec-home-adapter) — mainly German, and usually the quickest way to an answer. For something that looks like a bug, please open an issue on [GitHub](https://github.com/nobl/ioBroker.senec/issues). It helps to include your system model, which connectors you have enabled, the adapter and ioBroker versions, and a debug-level log covering the failure — the documentation walks through [collecting one](docs/en/README.md#collecting-a-debug-log) and [what makes a report actionable](docs/en/README.md#reporting-an-issue).

One thing worth checking first: implausible readings usually originate in the appliance rather than in the adapter, which mostly passes values through. A value that looks wrong on the dashboard will generally look just as wrong in the appliance's own web interface — and if it does not, that difference is exactly what to put in the report.

## Disclaimer
**All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal.**

**Control features are used at your own risk.** Force charge, appliance reboot, emergency power reserve, peak shaving, SG-Ready, socket switching and wallbox control each have to be enabled deliberately and acknowledged in the settings before they appear. The adapter sends what it is asked to send; it does not arbitrate between conflicting commands arriving from different connectors, nor does it judge whether a command is sensible for your system.

**Polling too aggressively can overload the appliance.** Shortening the local polling interval or adding extra high-priority data points can make the device restart, stop responding, or fail to synchronise with the SENEC cloud. If that happens, reduce the frequency or stop the adapter. The defaults are chosen to be safe.

**No warranty, and no liability.** This adapter is a spare-time project, provided as-is under the MIT license. It talks to an expensive appliance over interfaces SENEC neither documents nor supports, and it can send commands that change how that appliance behaves. Everything you do with it is your own responsibility. The author accepts no liability for damage to your system, lost or wrong data, missed feed-in, or any other consequence of using it — and cannot tell you whether using it affects your warranty or support arrangements with SENEC or your installer. If that is not acceptable to you, please do not use this adapter.

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

## Supporters
I am grateful to everyone who supports my work through GitHub Sponsors and in other ways. See [SUPPORTERS.md](SUPPORTERS.md) for acknowledgements.

## Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->
### 2.15.5 (2026-09-16)
- Fix: A mail address configured with a space at its end made the SENEC App API login fail on every single attempt. The app login asks for the username first and resolves the domain behind the `@` to decide whether the account belongs to an identity provider — `example.com ` is not a domain, so that step was answered with "Unexpected error when handling authentication request to identity provider", which names neither the address nor the space. The mein-senec.de connector is served a single form carrying username and password, validates the credentials directly and trims the username on the way, so the same address worked there and the two connectors disagreed about credentials that were identical. Leading and trailing whitespace is now removed from the configured address, zero-width characters along with it, and the correction is logged as a warning. The password is left untouched — a space at either end of it may be part of it.
- Change: The SENEC App API login writes the names of the fields it posts in each step to the debug log. The values are not logged. Whether the adapter returns the form the SSO served is the first thing a refused login has to be checked against, and reconstructing it needed a separate script run on the reporter's machine.
- Change: The login names the account it is attempted with, masked to the first character and the domain. A login that is refused while the credentials are known to be correct could not previously be checked against the address the adapter actually uses.
- Change: The steps of the App API login ask the SSO for a page rather than for JSON. Every step of the login is answered with an HTML page, while the shared client asks for JSON, which suits the mein-senec.de calls and the token endpoint. The token requests now state that expectation themselves instead of relying on the shared default.
- Dependency updates

### 2.15.4 (2026-09-12)
- Dependency updates

### 2.15.3 (2026-08-31)
- Fix: The SENEC App API login posted only the fields it fills in itself and did not send back the hidden fields the login form contains. A browser sends those back, and the SSO uses them to carry the state of a login across its steps, so an account whose login takes a route that depends on them could not get past the first step. Every field of the form is now returned with the values the adapter supplies on top. This applies to the two-factor step as well, where the form names which of several configured codes is being answered.
- Fix: The mein-senec.de login had the same gap and now sends the form's hidden fields back as well. Its login-page debug dump is redacted before it is written, which it previously was not.
- Change: A login step that fails now records the page the SSO answered with, without *Log requests and responses* having to be switched on beforehand. The instance log level still has to be `debug` or more verbose, and the adapter now checks that before it does the work — it previously prepared the page at every log level and then handed it to a call that discarded it. The one-line reason says which step failed but not what the SSO put in front of the adapter, which is where an unexpected login route shows itself, and by the time a report is written the login that produced it is gone, so it cannot be asked for afterwards. A login failing the same way on every retry writes the page once and afterwards only notes that it has not changed — the comparison now ignores the identifiers the SSO issues afresh for every attempt, which previously differed each time and defeated it.
- Change: More of a logged login page is masked. Login codes are masked as hidden form values as well as in query strings, the account's mail address is masked in its plain, percent-encoded and HTML-entity-encoded spellings, and a password echoed back inside a form value is masked. The pages are shortened before they reach the log.
- Change: The short error text taken from a rejected login page now goes through the same masking as the debug page dump. It is logged at `error` level, so it is visible at the default log level — a wider audience than the page dump reaches, and until now it was the less thoroughly redacted of the two.
- Change: With *Log requests and responses* switched on, the login form as it was served and the page after the username step are logged as well. These say nothing when a login works, so they stay behind the option.

### 2.15.2 (2026-08-28)
- Fix: A failing SENEC App API login reported nothing but `Request failed with status code 400` — neither which of the four requests of the login had failed nor what the SSO had said about it, which is all the information there is. Every step of the login now names itself and repeats the reason the SSO gave, so a login that fails on one account but not on others can be told apart from an outage.
- Fix: The request/response log (settings → SENEC App API → *Log requests and responses*) covered the data requests but not the login, so switching it on to investigate a login problem produced nothing about the login. It now logs each step of the SSO exchange as well, including where a redirect leads. Login codes are masked and neither credentials nor request bodies are ever written to the log.
- Change: A stored refresh token the SSO no longer accepts is an ordinary event — it happens whenever the session behind it has expired, and the full login that follows is the cure, not a symptom. It is no longer logged as a warning, so an ordinary re-login stops reading like a fault.
- Change: When the SSO ends the login somewhere other than the app itself — a further login step, or a refusal — the adapter now names the destination instead of reporting a missing authorization code.
- Dependency Updates

### 2.15.1 (2026-08-23)
- Dependency Updates

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
