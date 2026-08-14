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
### 2.15.0 (2026-08-14)
- 🔎 **Wanted: testers for the SENEC.Connect connector.** I cannot see what your subscription returns, and real responses are what this connector is missing — especially from accounts holding more than one system, and from responses containing more than `battery` and `meter` (`evse`, `bessNameplate`). If SENEC.Connect reports anything at all for your account, please get in touch in the [ioBroker forum thread](https://forum.iobroker.net/topic/30620/neuer-adapter-senec-home-adapter) or via a [GitHub issue](https://github.com/nobl/ioBroker.senec/issues).
- **Breaking (SENEC.Connect only):** The systems of a SENEC.Connect account were stored by their position in the API response, as `_connect.Systems.0.*`, `_connect.Systems.1.*` and so on. The API does not promise an order, so on an account with more than one system that position can change from one poll to the next — two systems then swap their states inside the same history, with nothing in the values to show it happened. Each system is now stored under the system id from its `bessNameplate` section instead, for example `_connect.Systems.P4H1-1234567.*`, and gets a channel named after its model. A system is remembered by every identifier it has ever reported, so a response that omits one of them does not move it; a system that reports no identity at all keeps its old position-based path and is left alone. The old numbered states are deleted on the first poll after the update; scripts, charts and visualisations that refer to them have to be pointed at the new paths, and the history recorded under the old paths ends there. **If you log these states with a history adapter, that setting is stored on the state and does not survive the move — switch logging back on for the new paths, or recording stops silently.** Accounts with a single system are affected the same way, but nothing else changes for them.
- **Breaking (SENEC.Connect only):** Wallboxes are stored under the `id` they report rather than their position in the response, for the same reason and with the same consequence — `_connect.Systems.{system_id}.evse.{wallbox_id}.*`. A wallbox that disappears from the response now has its states removed instead of leaving them frozen at their last values, looking current.
- New: `_connect.info.systemCount` reports how many systems SENEC.Connect returns, and the states of a system the API stops reporting are removed.
- New: SENEC.Connect has its own request timeout, adjustable between 5 and 120 seconds and 30 seconds by default. It previously borrowed the local appliance's timeout, which is capped at ten seconds and is not even shown unless the local connection is switched on — so a slow cloud response failed every poll with no reachable setting to change.
- Fix: A SENEC.Connect reply that arrived with a success code but did not contain the expected data — an error page or a captive portal, for instance — left the connector reporting itself as connected indefinitely while nothing was being read.
- Fix: A SENEC.Connect polling interval outside the permitted range is corrected on start-up, as the other intervals already were. Only a value written directly into the instance settings could get there, but a negative one made the adapter poll a request-metered API in a tight loop.
- Fix: A SENEC.Connect request in progress is now cancelled when the adapter stops, instead of running on and writing during shutdown, and it identifies itself with the same user agent as the adapter's other requests.
- Fix: Clearing the SENEC.Connect section list in the settings fell back to fewer sections than the field's own default, silently dropping wallbox data.
- Change: The `bessNameplate` section is now always requested from SENEC.Connect regardless of the configured sections, because it carries the id the states are stored under. The API is billed per request, not per section, so this costs nothing.
- Fix: When mein-senec.de measurement detail states were cleared at the daily rollover and written again in the same cycle, they came back as bare values — the name, unit and role were gone, because the adapter still believed the deleted definitions existed.
- Fix: On appliances not set to German, `ENERGY.STAT_STATE_Text` was never created at all. It puts the numeric system state into plain language — "Laden", "Akku voll", "Fernabschaltung" — but the English and Italian tables were stored under a name the adapter never looked them up by, so nothing was written and no error appeared. English is also what the adapter falls back to when it cannot read the appliance's language, so this affected most installations. The state now appears; on an affected system it shows up as a new datapoint after the update. `FACTORY.COUNTRY_Text` was missing on Italian appliances for the same reason.
- Fix: System state 41 was labelled "Schlafmodus" / "Sleeping mode". The appliance itself calls it "Abschaltung Lithium" / "Lithium shutdown", which is a different condition; the Italian text already said so. State 74 also carried a spelling mistake.
- New: Three more numeric datapoints are translated into text — `BMS.MANUFACTURER_Text` names the battery module generation (BMZ or Ampace / LFP), `PWR_UNIT.ENFLURI_Text` says which meter a power unit is measured by, and `CASC.STATE_Text` gives the cascade state.
- **Change: A datapoint your appliance does not have no longer gets a state, and an existing one says so.** The adapter asks every appliance for the same set of datapoints and no model provides all of them, so the answer "I do not have that one" is normal rather than a fault. Until now that answer was stored as the value, so the state read `VARIABLE_NOT_FOUND`. No state is created for it any more, and one that already exists is set to "not provided by appliance" so it is obvious at a glance instead of sitting there with a stale number that still looks current. Nothing is deleted, nothing is reported as a problem, and nothing is required of you. A datapoint that merely failed to be read this once is left untouched, because the real reading is expected back. A whole section your appliance does not have is handled the same way; it previously left behind a state called `<SECTION>.OBJECT_NOT_FOUND` holding nothing. This covers what the adapter asks for by name and the sections it requests — a field that quietly vanishes from a section still being provided cannot be detected this way, because the appliance simply omits it rather than saying anything about it.
- Fix: An unreadable datapoint could be published as a real-looking measurement. The appliance answers with a word where a number was expected, and that word slipped into the conversions for flags, factors, dates and IP addresses: a flag was stored as `true`, a scaled value as `NaN`, a timestamp as "Invalid Date" and an address as garbage. Nothing is stored for such an answer any more, so a state either holds a real reading or does not exist. A datapoint answering with an empty value no longer becomes `0` either, and a few value formats the appliance uses were decoded wrongly — text beginning with "u" could be read as a number, so a state could show 14 where the appliance had sent no reading at all.
- Change: `ENERGY.GUI_BAT_DATA_OA_CHARGING` is no longer polled every few seconds. A SENEC.Home V3 does not have it, it is absent from every field that appliance reports for this section, and the appliance's own web interface never asks for it. It remains defined, so an older appliance that still provides it keeps the state from the slower poll.
- Fix: The appliance's display language was read once at start-up, in a race with the first poll of the datapoint that carries it. On a fresh installation the adapter could therefore stay on English for the whole session, and changing the language on the appliance never took effect until the adapter was restarted. It is now picked up as soon as the appliance reports it, and a language the adapter has no texts for falls back to English instead of silently leaving every translated state empty.
- Fix: A code that is not in a translation table was shown as "(unknown)", which discarded the very number needed to identify it. It now reads "(unknown 7)". If you see one, the number is worth reporting.
- Change: Translated `_Text` states are no longer marked writable — writing to them never did anything — and are declared as text rather than as a measurement. Existing ones are corrected on the first poll after the update.
- Fix: The operating-mode text on the web dashboard now comes from the appliance's own system state on English and Italian systems as well. It previously fell back to the cloud status text there, because the local text did not exist.
- Fix: Several labels in the English and Italian system-state lists were misspelled, one Italian entry contained a stray fragment of an untranslated string, and some Italian entries were missing their accents.
- Change: The adapter warns when the datapoints configured for high-priority polling make a request large enough to approach the size the appliance can still answer. Beyond that size the appliance replies with a truncated body, which used to surface only as a connection error.

### 2.14.2 (2026-08-13)
- Dependency updates

### 2.14.1 (2026-08-02)
- Fix: Emptying one of the additional high-priority datapoint fields left its "add datapoints to polling" box ticked, and the adapter then reported a faulty configuration on every start although nothing was configured at all. Such a field is no longer treated as an error, which also settles it for instances that are already in this state; clearing the field now unticks the box as well. Two related problems are fixed with it: a blank after a comma discarded the whole entry instead of being read as the separator it is, and a trailing comma sent a nameless datapoint to the appliance. An entry containing an invalid name is still ignored as a whole, but the warning now names the part that caused it.

### 2.14.0 (2026-08-01)
- Fix: With the local connection switched on but no IP address entered, the adapter repeatedly tried to reach 0.0.0.0 and logged a connection error on every attempt. It now says once that no address is configured and waits for one.
- Change: A new instance now starts with no connector preselected — pick the ones you want in the settings. The local connection is no longer switched on in advance, and its address field starts empty instead of showing 0.0.0.0. Existing instances keep their settings unchanged.
- Fix: When the SENEC sign-in service rejected the stored token and was itself unreachable, the adapter attempted a full login twice and then kept two recovery loops running side by side, doubling every request. It now makes one attempt and retries on a single schedule.
- Fix: If the appliance was unreachable at start-up and only answered on a later attempt, sections found during that attempt were not actually polled until the adapter was restarted.
- Fix: Four of the six mein-senec.de queue diagnostic states were always empty. They now report real values and count finished requests rather than started ones, so the success rate is no longer dragged down by work still in progress.
- Fix: The two mein-senec.de debug settings only took effect when measurement history polling happened to be switched on as well. They now work on their own.
- Fix: An external source using a formula with several references was recalculated once per reference at start-up, reading every referenced state repeatedly. It is now calculated once.
- Fix: A battery level of infinity from an external source, and a kilowatt reading too large to express in watts, are no longer written to states.
- Fix: When mein-senec.de asks the adapter to wait before retrying, a wait expressed as a date is now understood as well as one expressed in seconds. An implausibly long wait is capped at an hour so the connector always recovers on its own.
- New: The timeout for ordinary SENEC API requests is configurable, and its default is raised from 10 to 30 seconds. The API is regularly slow enough that dashboard and system status requests were timing out, which loses the whole reading until the next poll cycle. Measurement history keeps its own, longer limit.
- Fix: An error reply from mein-senec.de was treated as if it were data. A failed request could write an error page into the status states, advance the "last poll" timestamp and leave the connector reporting itself as connected. Responses are now checked centrally, so a failure is a failure everywhere.
- Fix: The adapter no longer keeps its request rate up when mein-senec.de is struggling. A server error now pauses the whole queue briefly, exactly as rate limiting already did, and the server's own requested delay is honoured. Control commands are still never repeated automatically.
- Fix: If the SENEC login had to be renewed and that renewal failed, the adapter could end up with no token, no scheduled retry and no error — silently stuck until restarted. It now retries with a growing delay, so it recovers on its own.
- Fix: Measurements for "today" and "yesterday" could be fetched for the wrong day between midnight and the UTC changeover — up to two hours every night in Central European time, and any part of the night in other time zones.
- Fix: The battery level recorded from mein-senec.de lost a full day twice a year, at the daylight-saving changeovers, because two adjacent days were not recognised as adjacent.
- Fix: Sections the appliance did not list during discovery are no longer dropped from polling. A restricted or partial answer could previously reduce the adapter to polling almost nothing, including the live values.
- Fix: A failing poll step is now counted, so a system that is only partly readable is reported instead of passing as healthy.
- Fix: External energy sources sharing one foreign state now all update. Previously only the last one configured for a given state received changes, and a state used both directly and in a formula drove only one of the two. Values are also read once at startup instead of showing 0 until the source next changes, and a formula that divides by zero no longer writes Infinity.

### 2.13.1 (2026-08-01)
- Fix: A failed API read is now retried instead of being dropped until the next poll cycle. Retries apply to transient failures only — timeout, rate limiting, server error, dropped connection. Control commands are never retried, so none can reach the appliance twice.
- API: A poll tier that could not complete now says so in the log, along with the fact that it is picked up again on the next cycle. Previously only the failure was logged, which read as if the data were lost.
- Fix: Rate limiting by mein-senec.de went unnoticed. Its responses are read directly rather than raised as errors, so a "too many requests" reply counted as a success and the adapter kept its request rate up instead of easing off. It now backs off, honours the server's own retry delay, logs the event, and reports it under the connector's rate-limit diagnostics. Most noticeable when stepping through statistics weeks quickly. The same applies to a request repeated after a session expired, which previously skipped this handling altogether.
- Fix: Downloading a statistics week ran into the short timeout meant for the portal's small JSON replies. A week at 5-minute resolution now gets a timeout that fits it.
- Fix: A statistics week the server refused to send was displayed as an empty week rather than as an error.
- Fix: A dashboard label could briefly show its key name (`stats_title`) instead of its text. Translation dictionaries are now revalidated on every load, views wait for them before drawing, and a label whose key cannot be resolved keeps its English text instead of being overwritten with the key.

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
