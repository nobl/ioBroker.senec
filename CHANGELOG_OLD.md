# Older changes

The newest change log is [README.md](README.md)
## 2.9.2 (2026-07-16)
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

## 2.9.1 (2026-07-16)
- Fix: jsonConfig validation error (`collapsed` not allowed on panel type)
- Fix: Welcome screen tile color changed from green to SENEC blue

## 2.9.0 (2026-07-15)
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

## 2.8.4 (2026-07-13)
- Web measurements: Measurement history (today, yesterday, monthly, yearly, AllTime) and autarky can now be polled from mein-senec.de. Data appears under `_meinsenec.Measurements` and `_meinsenec.Autarky`. Enable in adapter settings with "Poll measurement history". Optional 5-minute detail data with time-based keys for today/yesterday (creates ~3,500 additional states).
- Web request queue: All mein-senec.de requests now use an AdaptiveRequestQueue for rate-limiting. Configurable concurrency and min request interval in adapter settings.
- API/Web request interval: Minimum time between requests is now configurable for both API and web connectors (API previously hardcoded at 400ms).
- User-Agent settings moved from SENEC App API tab to SENEC Account tab — now applies to all connectors.
- Queue diagnostics cleanup: Diagnostics states for both API and web queues are now automatically cleaned up when debug states are disabled.

## 2.8.3 (2026-07-12)
- Active measurement periods (current year, current month, today) no longer skip re-fetch — frequency is now fully controlled by the configured tier intervals
- AllTime history now tracks a `last updated` timestamp

## 2.8.2 (2026-07-09)
- removed v2.8.0 from documentation - it never was released

## 2.8.1 (2026-07-09)
- Housekeeping
- Code optimizations
- Log messages now include connector prefix ([API], [Local], [Web], [Connect]) for easier filtering and debugging

## 2.7.0 (2026-07-07)
- SENEC Account tab: Shared credentials (email, password, TOTP) moved to a dedicated tab, always visible regardless of which cloud features are enabled.
- mein-senec.de controls: Emergency power reserve, peak shaving (mode, capacity limit, end time), and SG-Ready settings can now be controlled via mein-senec.de. Controls appear under `control.EmergencyPower`, `control.PeakShaving`, and `control.SGReady`. Enable in adapter settings under Appliance Control.
- Switchable socket control via mein-senec.de: Sockets can now be controlled via mein-senec.de web portal in addition to local lala.cgi. Unified control datapoints (Mode: Off/On/Auto, thresholds, durations, switch-on time) work with both connectors. A force override option is available for systems where socket capability is not detected.
- Connector-based control routing: Appliance Control tab restructured with per-connector consent checkboxes and per-feature connector dropdowns (Off/Local/API/Web). Only one connector per feature to avoid conflicts. Warning messages shown when a selected connector is not enabled.
- Independent control gates: Web, API, and local controls each have independent gates in state change handling. API controls no longer require local lala.cgi connection. Fixed plant number 0 falsy bug.
- API error handling: All mein-senec.de POST handlers check HTTP response status and log error messages from the API.
- Peak shaving fixes: Capacity limit uses correct field (peakShavingCapacityLimitInPercent), capped at 90%. End time split into EndHour/EndMinute fields. UTC timestamp construction for correct time handling with SENEC API.
- Debug & Logging tab: Debug settings moved to a dedicated tab applying to all connectors. Request/response logging now includes mein-senec.de traffic.

## 2.6.0 (2026-07-06)
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

## 2.5.5 (2026-07-06)
- Add TOTP/2FA support for SENEC API login (configure TOTP secret in adapter settings)
- Replace plain setTimeout/clearTimeout with adapter-managed timers
- Dependency updates

## 2.5.4 (2026-05-27)
- Adapter requires node.js >= 22 now
- Minor fixes
- Dependency updates

## 2.5.3 (2026-04-13)
- Clamping end-dates to current time if they are in the future to avoid issues with API
- Dependency updates
- Updated iobroker\testing-action-* versions

## 2.5.2 (2026-03-31)
- Rewrote AllTime History Rebuild: We should now be able to rebuild AllTime History even if the senec server struggles with timeouts. Warning! Rebuild will take considerable time now depending on the server. Current state of rebuild will be reported to log (info).
- You will now need to supply the installation year of your appliance upon AllTime History rebuild if you don't want empty yearly folders in the measurements path for yours you don't have data.
- More comprehensive logging on what is being polled from API.
- Better debug-logging for polling

## 2.5.1 (2026-03-31)
- Increased default API poll interval to 6 minutes. This appears to be causing less issues with the server than 5 minutes.
- You can now define different polling intervals for dashboard (frequently), details (usually hourly and daily information), heavy (for everything else that usually is done per month or year).<br>Please be careful with high frequency polling as this can and will lead to problems and the senec server will stop responding to your requests. Longer delays between polls are preferred.
- Dependency updates
- Code optimizations

## 2.5.0 (2026-03-28)
- Added control.RebootAppliance to initiate appliance reboot. Only works if local lala.cgi is available and connected. Function requires extra permission via adapter settings. Please use responsible!
- We are now revealing that an ioBroker integration is accessing the API per default (UserAgent is set to 'integration'). Please consider leaving that to 'integration' so SENEC knows there are many users using the ioBroker integration. If you don't want this or experience issues with 'integration' UserAgent, check settings and revert UserAgent to 'Browser' or define your 'custom' UserAgent.
- Fixed incremential back-off for local polling.
- Moved local appliance control settings into own tab.
- Concurrency for API requests can now be controlled via settings. Please be cautious! Senec API is fragile. Go with 1 concurrent request if you experience issues.
- You can now enable diagnostics for api-request-queue. You can log them to 'info' log or have them in _api.diagnostics.queue.*
- Reduced local polling interval for lowPrio to 5 minutes.
- UI now hides unavailable options.
- Added option to remove API log spam. If you don't need to know every few minutes we are refreshing tokens or polling the API: Deactivate it.
- Partial code rewrite (you can now safely have several instances of adapter - if you ever wanted)
- Dependency updates

## 2.4.8 (2026-03-14)
 - Connection type now is "cloud" (ioBroker internal setting) - although we still support local interaction (if possible per individual appliance)
 - Dependency updates

## 2.4.7 (2026-03-14)
- Clearly indicating that initial API login busted and adapter will turn off API polling until restart
- Certain warnings moved to debug (as they are pretty much for debug purposes only)
- Made usage of axios-cookiejar-support ESM compatible (dynamic import). Solves issues with node 22.
- RND made node22+ safe.
- Code optimizations

## 2.4.6 (2026-03-09)
- Optimizations in Token Refesh Szenarios
- Optimizations in case of authentication issues
- Persisted RefreshToken across adapter restarts (less logins)
- Reworded errors/warning messages
- Dependency updates

## 2.4.5 (2026-03-03)
- fixed typo that made today/hourly today/horly. You can safely delete the horly branch Measurements/Daily/horly
- Updated delay for token refresh (it can be up to 2 min now).

## 2.4.4 (2026-03-03)
- Exponential backoff, if all systems cannot get polled. If at least 1 system can be polled we resume normal action. Now - if all systems fail polling (like 1 if you only have 1) this would be example backoff times for a 5min base interval: 1 Failure -> 0-10 min, 2 Failure -> 0-20 min, 3 Failures -> 0-40 min, 4+ Failures -> 0-40 min. Once polling works again we will resume normal operations.

## 2.4.3 (2026-03-03)
- API uses its own backoff settings when polling. You can only configure delay between polls. Instead we are using strategy used by: AWS SDK, Google Cloud SDK, Stripe API client, Kubernetes controllers or Distributed message brokers to prevent: retry storms, thundering herd, burst collapse after outage recovery, adapter lockups or permanent dead loops. This leads to: IF (SENEC API down for 2 hours, or Token refresh fails 20 times, or 429 rate limiting kicks in, or Internet drops temporarily) ? (Never dies, never overlaps, never floods API, always recovers)
- API polling no longer honors retries-setting. It will just keep backing off exponentially if errors persist -> we keep trying until you stop the adapter.
- Using Token-Refresh strategy. No unnecessary logins anymore.
- 401 won't throw warning anymore
- ReAuth shouldn't stop polling anymore

## 2.4.2 (2026-03-03)
- AuthToken in _api is no longer used. You can safely delete it.
- Decoupled frequencies to lower API load. Every poll: Dashboard and today values; Once per day: Yesterday, Monthly, Yearly values (we reduce load by about 65% compared to polling everything every time)
- AccessToken logic centralized
- True Single Flight Token refresh (avoiding duplicate logins, duplicate login storms)
- Avoiding overlapping Polls
- exponential backoff on auth failure
- retry backoff
- proper lifecycle safety
- Automatic 401 retry

## 2.4.1 (2026-03-01)
- Fixing issues with polling from senec api when token expires
- Old entries in changelog moved to old.

## 2.4.0 (2026-02-28)
- Senec changed login procedure (again). Adapter now also works with 2-stage login where senec asks for username/email first and password second.
- Dependency updates

## 2.3.0 (2026-02-17)
- Measurements for today and yesterday are also available by the hour
- Measurements for month and previous month are also available by day
- Measurements for year are also available by month
- Unit calculation fixed if we don't know the unit yet per state_attr.js
- Added definitions for cascadeDevicesCount and mode
- Dependency update

## 2.2.2 (2026-02-06)
- Migrated to i18n
- Update handling of "new" states that are just an "extra" to an existing state like state and state.1 or state.42
- Dependency Updates

## 2.2.1 (2026-02-06)
- Fixed: History rebuild will only run once now when requested (remember: To force rebuild you need to configure this in settings)

## 2.2.0 (2026-02-05)
- Polling yearly measurements as year from API - not months (and summing them up)
- Added back AllTimeHistory with BATTERY_LEVEL_IN_PERCENT averaged and AUTARKY_IN_PERCENT calculated
- Removed selection to use https or http for lala.cgi. https is enforced now.

## 2.1.3 (2026-02-04)
- reading all previous years (up to inception of SENEC) added again (to make this happen: activate recalculation of full history via settings)
- added today / yesterday again
- optimizations for measurements handling
- less log noise

## 2.1.2 (2026-02-04)
- more silencing log messages
- housekeeping

## 2.1.1 (2026-02-04)
- fixed datatype for WIZARD.SG_READY_CURR_MODE
- less logging (moved some info to debug again)

## 2.1.0 (2026-02-04) - the API returns - finally finally hopefully finally
- Complete rewrite of the Senec API functionality. Thanks to @timfxtones for pointing me in the right direction
- No longer using the web-interface at mein-senec.de - it didn't work properly on the long run ...
- Still missing some datapoints so far. They will be implemented in the future.

## 2.0.0 (maett81, NoBl)
* Updated to use new SENEC API via mein-senec.de - Thanks to @maett81
* Some code and dependency housekeeping

## 1.6.17
* License update

## 1.6.16
* Moved Dashboard to ApiV2. This invalidates existing datapoints under /Dashboard/ and introduces "Dashboard/currently" and "Dashboard/today" due to changes in the API.

## 1.6.15
* Maintenance update (dependencies, ...)

## 1.6.14
* Bugfix (values were way off)

## 1.6.13 (NoBl)
* Removed Support for node 16
* Added more translations
* Code cleanup

## 1.6.12 (NoBl)
* Updated license

## 1.6.11 (NoBl)
* Moving from Senec App API 3.12.0 to 4.3.3 (thanks to oakdesign@github for providing the new API!)
* This WILL invalidate all current API datapoints in the Statistik branch. Easiest solution to this: Delete the Statistik branch.
* Remember to force a rebuild of historic data in adapter settings!

## 1.6.10 (NoBl)
* Bugfix for AllTimeHistory (should work again)

## 1.6.9 (NoBl)
* Added switch in config to enable active control of appliance (you will need activate this, if you want to control the appliance via the adapter)
* Improved handling of forced loading (please report if we need more appliance-states covered by this)
* Minor improvements and bugfixes

## 1.6.8 (NoBl)
* Added switch control.ForceLoadBattery to start/stop charging battery. Use this to start/stop forced charging (like with dynamic power prices, ...).

## 1.6.7 (NoBl)
* Added option to turn off local polling.

## 1.6.6 (NoBl)
* Node 16 required
* Bugfixes
* Removed non-existing branches: _calc, Bat1Obj[2-4], Display, Statistic, File
* Added branches: CURRENT_IMBALANCE_CONTROL, BMZ_CURRENT_LIMITS, CELL_DEVIATION_ROC, SENEC_IO_OUTPUT, SENEC_IO_INPUT

## 1.6.5 (NoBl)
* Added AllTime Statistics (trigger initial calculations in adapter settings)
* https is now default for new instances

## 1.6.4 (NoBl)
* Bugfix (numbers are numbers again)

## 1.6.3 (NoBl)
* Code optimization

## 1.6.2 (NoBl)
* Added statistics values from API along with some own calculations.

## 1.6.1 (NoBl)
* Bugfixes

## 1.6.0 (NoBl)
* Added option to also poll SENEC App API. This requires user credentials for mein-senec.de
* We are starting with just some information - more to follow. But with Dashboard we at least have current values and day statistics back.

## 1.5.1 (NoBl)
* Added more datapoints. If you experience messages in log - feel free to add them yourself to state_attr on github (pull request)
* Autarky calculations will stopp working because SENEC removed STATISTICS branch.
* If you experience issues with connecting to your appliance after it got updated, please activate https connection in settings.

## 1.5.0 (NoBl)
* Added configuration section to add datapoints to high priority polling. Please be aware of the possible issues this could cause (if too many datapoints added) and use at your own risk.
* ALL Wallbox datapoints have been removed from high priority polling. Only some users even have a SENEC wallbox. Please reconfigure via the new config dialogue.
* Possible Candidate for stable. Please report any findings!

## 1.4.3 (NoBl)
* Working on https connection. Please test and report!

## 1.4.2 (NoBl)
* Added option to use https for connecting to SENEC (only activate if your appliance supports / requires this!)

## 1.4.1 (NoBl)
* Fix: Autarky calculations are working again.

## 1.4.0 (NoBl)
* Added object caching along with some minor code updates. Due to the amount of objects we deal with caching is about mandatory.

## 1.3.10 (NoBl)
* Fixed wrong Unit for STATISTIC.LIVE_WB_ENERGY
* Updated to json Admin UI
* Technical Updates
* Added more state_attr definitions

## 1.3.9 (Nobl)
* Added (some) Wallbox Datapoints to high-prio polling
* Added more state definitions

## 1.3.8 (NoBl)
* Removed (unnecessary) admin tab

## 1.3.7 (NoBl, noffycws, git-ZeR0)
* Updates to state translations (new values when SENEC turned off appliances)
* Added state definitions
* Added high priority datapoints: temperatures, voltages, ... to better monitor safety relevant data

## 1.3.6 (NoBl)
* Fixed log.warning error

## 1.3.5 (NoBl)
* Added more state attributes (if you have updated descriptions or anything, please open an issue!)
* Workaround in case SENEC reports bogus request data

## 1.3.4 (NoBl)
* Moved from request to axios
* Added more state attributes (if you have updated descriptions or anything, please open an issue!)

## 1.3.3 (NoBl)
* Updated to current template.

## 1.3.2 (NoBl)
* Autarky without decimal places (again). They are causing more updates than we really need.
* Autarky values won't reset to 0 at change of timeframe (day, week, ...) anymore. They are calculated based on reference values anyways.
* Ensuring that only values meant to be changeable by user are defined so (attribute changes upon the next update of value)

## 1.3.1 (NoBl) 20210513
* Added calculation of autarky for day/week/month/year

## 1.3.0 (NoBl) 20210509
* Rewrote translations handling
* Added translations for wallbox status.
* Translated status get an extra datapoint with _Text as postfix. Former translations that didn't add an extra dp will now revert to their numeric representation and add the _Text DP.
* Translations are now handled via lib/state_trans.js for all 3 languages available in the senec system (german, english, italian).
* Language used is decided by the language of the SENEC appliance.

## 1.2.0 (NoBl)
* Added datapoints for: PM1OBJ1, PM1OBJ2, EG_CONTROL, RTC, PM1, TEMPMEASURE, DEBUG, SOCKETS, CASC, WALLBOX, CONNX50, STECA (please report wrong / missing units).
* Adapter now calculates day/week/month/year-values for: STATISTIC.LIVE_GRID_EXPORT, STATISTIC.LIVE_GRID_IMPORT, STATISTIC.LIVE_HOUSE_CONS, STATISTIC.LIVE_PV_GEN, STATISTIC.LIVE_BAT_CHARGE_MASTER, STATISTIC.LIVE_BAT_DISCHARGE_MASTER. Calculated values can be found below the "_calc." datapoint. Information about daily values was removed from the API by SENEC in the past. So here we go again ...

## 1.1.1 (NoBl)
* Object attributes are updated to what they are expected to be: unit, description, datatype (this will break anything that still relies on datapoints being STRING that aren't meant to be string)

## 1.1.0 (NoBl)
* Updated to current adapter template
* Integrated GitHub Testing and auto npm publishing
* Some other administrative updates

## 1.0.13 (NoBl)
* Added System Description 19 for Senec.Home V3 Hybrid (Credits to noffycws)
* Added Mode Descriptions for 86-91. (Credits to noffycws)

## 1.0.12 (NoBl)
* Just set 'supportCustoms' to false so it won't show up in admin custom config.

## 1.0.11 (NoBl)
* Update to current adapter template
* Added Datapoints: PV1.MPP_CUR, MPP_VOL, MPP_POWER (former: MPP_INT which is unused at this moment but does still exist)
* Added Datapoints (please feedback any improvements for their descriptions, ...): FEATURES.SGREADY, WIZARD.SETUP_WALLBOX_MAX_TOTAL_CURRENT_BY_GRID, WIZARD.SG_READY_CURR_MODE, BMS.ERROR, BMS.RECOVERLOCKED, BMS.SERIAL, BMS.START_SELFTEST, BAT1.RESET, BAT1.SELFTEST_ACT, BAT1.SELFTEST_LIMIT, BAT1.SELFTEST_OFF, BAT1.SELFTEST_OVERALL_STATE, BAT1.SELFTEST_STATE, BAT1.SELFTEST_STEP, BAT1.SELFTEST_TIME, BAT1.SERIAL, BAT1.TRIG_ITALY_SELF, BAT1OBJ1.COMM, GRIDCONFIG.AU_SOFT_RAMP_EN, GRIDCONFIG.AU_VRR_MAX, GRIDCONFIG.AU_VRR_MIN, GRIDCONFIG.AU_VVAR_PERCENTAGE, GRIDCONFIG.AU_VVAR_P_MAX, GRIDCONFIG.AU_VVAR_P_MIN, GRIDCONFIG.AU_VVAR_VOLTAGE, GRIDCONFIG.AU_VWC_VOLTAGE, GRIDCONFIG.AU_VWD_VOLTAGE, GRIDCONFIG.CEI_SEGNALE_ESTERNO, GRIDCONFIG.VDELVFRTDISABLE, GRIDCONFIG.VDEURMSMAX10

## 1.0.10 (NoBl, smartpran)
* DateType objects are stored as date again
* changed WIZARD.SETUP_POWER_RULE unit to '%'
* changed name of STATISTIC.STAT_SUM_E_PU to "STAT_SUM Energy PowerUnit"
* changed name of STATISTIC.STAT_SUM_E_WB to "STAT_SUM Energy Wallbox"
* changed name of STATISTIC.LIVE_WB_ENERGY to "Live Wallbox Energy"
* changed name of STATISTIC.LIVE_PU_ENERGY to "Live PowerUnit Energy"
* changed name of WIZARD.PWRCFG_PEAK_PV_POWER to "Configured Peak PV Power"
* enforcing conversion of number values to Number(). Otherwise they are created as String in ioBroker (manually delete existing datapoints in ioBroker to change them!)
* fixed representation for temp values (off by *10)
* json delivers a non-value (apparently an error message produced by senec itself). Ignoring that.
* Added variable mpp_int to high priority and changed unit it. (smartpran)

## 1.0.9 (NoBl)
* IP types are shown as IP again.
* added datapoints for FACTORY along with more state descriptions for Battery Type, Country and System Type.
* added datapoints for GRIDCONFIG

## 1.0.8 (NoBl)
* Added more states to known states (please feedback if they need special handling (unit, special description, value modification, ...))
* Bugfix in creating debug data
* Unknown states are now reported in debug instead of info.
* Code cleanup

## 1.0.7 (NoBl)
* Reading all known states from SENEC.
* Split states into high/low priority (heavy requesting the SENEC system renders it unable to sync with the SENEC datacenter!).
* Updated adapter-core and testing versions along with current dev dependencies. Removed node 8 support.
* Added more state descriptions to manual. But need input on these and those that are still not documented.

## 1.0.6 (NoBl)
* Moved senec states and state attributes to libs
* Added missing state descriptions

## 1.0.5 (2020-03-07) (NoBl)
* Added States for: Energy: GUI_BAT_DATA_VOLTAGE, GUI_BAT_DATA_CURRENT, STAT_HOURS_OF_OPERATION; Sys_update: NPU_VER, NPU_IMAGE_VERSION, Wizard: APPLICATION_VERSION, INTERFACE_VERSION
* Readme and Documentation (EN exists, now) updated
* Changed behavior for unknown values completely. They will now be stored as string plus prefixed with "REPORT TO DEV:" so users can easily report back what needs updating.
* added handling for "st_" values in json
* added additional configuration options
* changed retry-behaviour in case of connection issues, ...

## 1.0.4 (2020-03-06)
* (NoBl) Repo URL updated

## 1.0.3 (2020-03-06)
* (NoBl) added link to documentation in german

## 1.0.2 (2020-03-04)
* (NoBl) added missing status codes (85 in total now)
* (NoBl) added status code to status message for easier reference
* (NoBl) added states for wallboxes and battery modules

## 1.0.1
* (NoBl) updated readme

## 1.0.0
* (NoBl) initial release