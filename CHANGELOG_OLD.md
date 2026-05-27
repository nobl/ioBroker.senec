# Older changes

The newest change log is [README.md](README.md)

### 1.6.17
* License update

### 1.6.16
* Moved Dashboard to ApiV2. This invalidates existing datapoints under /Dashboard/ and introduces "Dashboard/currently" and "Dashboard/today" due to changes in the API.

### 1.6.15
* Maintenance update (dependencies, ...)

### 1.6.14
* Bugfix (values were way off)

### 1.6.13 (NoBl)
* Removed Support for node 16
* Added more translations
* Code cleanup

### 1.6.12 (NoBl)
* Updated license

### 1.6.11 (NoBl)
* Moving from Senec App API 3.12.0 to 4.3.3 (thanks to oakdesign@github for providing the new API!)
* This WILL invalidate all current API datapoints in the Statistik branch. Easiest solution to this: Delete the Statistik branch.
* Remember to force a rebuild of historic data in adapter settings!

### 1.6.10 (NoBl)
* Bugfix for AllTimeHistory (should work again)

### 1.6.9 (NoBl)
* Added switch in config to enable active control of appliance (you will need activate this, if you want to control the appliance via the adapter)
* Improved handling of forced loading (please report if we need more appliance-states covered by this)
* Minor improvements and bugfixes

### 1.6.8 (NoBl)
* Added switch control.ForceLoadBattery to start/stop charging battery. Use this to start/stop forced charging (like with dynamic power prices, ...).

### 1.6.7 (NoBl)
* Added option to turn off local polling.

### 1.6.6 (NoBl)
* Node 16 required
* Bugfixes
* Removed non-existing branches: _calc, Bat1Obj[2-4], Display, Statistic, File
* Added branches: CURRENT_IMBALANCE_CONTROL, BMZ_CURRENT_LIMITS, CELL_DEVIATION_ROC, SENEC_IO_OUTPUT, SENEC_IO_INPUT

### 1.6.5 (NoBl)
* Added AllTime Statistics (trigger initial calculations in adapter settings)
* https is now default for new instances

### 1.6.4 (NoBl)
* Bugfix (numbers are numbers again)

### 1.6.3 (NoBl)
* Code optimization

### 1.6.2 (NoBl)
* Added statistics values from API along with some own calculations.

### 1.6.1 (NoBl)
* Bugfixes

### 1.6.0 (NoBl)
* Added option to also poll SENEC App API. This requires user credentials for mein-senec.de
* We are starting with just some information - more to follow. But with Dashboard we at least have current values and day statistics back.

### 1.5.1 (NoBl)
* Added more datapoints. If you experience messages in log - feel free to add them yourself to state_attr on github (pull request)
* Autarky calculations will stopp working because SENEC removed STATISTICS branch.
* If you experience issues with connecting to your appliance after it got updated, please activate https connection in settings.

### 1.5.0 (NoBl)
* Added configuration section to add datapoints to high priority polling. Please be aware of the possible issues this could cause (if too many datapoints added) and use at your own risk.
* ALL Wallbox datapoints have been removed from high priority polling. Only some users even have a SENEC wallbox. Please reconfigure via the new config dialogue.
* Possible Candidate for stable. Please report any findings!

### 1.4.3 (NoBl)
* Working on https connection. Please test and report!

### 1.4.2 (NoBl)
* Added option to use https for connecting to SENEC (only activate if your appliance supports / requires this!)

### 1.4.1 (NoBl)
* Fix: Autarky calculations are working again.

### 1.4.0 (NoBl)
* Added object caching along with some minor code updates. Due to the amount of objects we deal with caching is about mandatory.

### 1.3.10 (NoBl)
* Fixed wrong Unit for STATISTIC.LIVE_WB_ENERGY
* Updated to json Admin UI
* Technical Updates
* Added more state_attr definitions

### 1.3.9 (Nobl)
* Added (some) Wallbox Datapoints to high-prio polling
* Added more state definitions

### 1.3.8 (NoBl)
* Removed (unnecessary) admin tab

### 1.3.7 (NoBl, noffycws, git-ZeR0)
* Updates to state translations (new values when SENEC turned off appliances)
* Added state definitions
* Added high priority datapoints: temperatures, voltages, ... to better monitor safety relevant data

### 1.3.6 (NoBl)
* Fixed log.warning error

### 1.3.5 (NoBl)
* Added more state attributes (if you have updated descriptions or anything, please open an issue!)
* Workaround in case SENEC reports bogus request data

### 1.3.4 (NoBl)
* Moved from request to axios
* Added more state attributes (if you have updated descriptions or anything, please open an issue!)

### 1.3.3 (NoBl)
* Updated to current template.

### 1.3.2 (NoBl)
* Autarky without decimal places (again). They are causing more updates than we really need.
* Autarky values won't reset to 0 at change of timeframe (day, week, ...) anymore. They are calculated based on reference values anyways.
* Ensuring that only values meant to be changeable by user are defined so (attribute changes upon the next update of value)

### 1.3.1 (NoBl) 20210513
* Added calculation of autarky for day/week/month/year

### 1.3.0 (NoBl) 20210509
* Rewrote translations handling
* Added translations for wallbox status.
* Translated status get an extra datapoint with _Text as postfix. Former translations that didn't add an extra dp will now revert to their numeric representation and add the _Text DP.
* Translations are now handled via lib/state_trans.js for all 3 languages available in the senec system (german, english, italian).
* Language used is decided by the language of the SENEC appliance.

### 1.2.0 (NoBl)
* Added datapoints for: PM1OBJ1, PM1OBJ2, EG_CONTROL, RTC, PM1, TEMPMEASURE, DEBUG, SOCKETS, CASC, WALLBOX, CONNX50, STECA (please report wrong / missing units).
* Adapter now calculates day/week/month/year-values for: STATISTIC.LIVE_GRID_EXPORT, STATISTIC.LIVE_GRID_IMPORT, STATISTIC.LIVE_HOUSE_CONS, STATISTIC.LIVE_PV_GEN, STATISTIC.LIVE_BAT_CHARGE_MASTER, STATISTIC.LIVE_BAT_DISCHARGE_MASTER. Calculated values can be found below the "_calc." datapoint. Information about daily values was removed from the API by SENEC in the past. So here we go again ...

### 1.1.1 (NoBl)
* Object attributes are updated to what they are expected to be: unit, description, datatype (this will break anything that still relies on datapoints being STRING that aren't meant to be string)

### 1.1.0 (NoBl)
* Updated to current adapter template
* Integrated GitHub Testing and auto npm publishing
* Some other administrative updates

### 1.0.13 (NoBl)
* Added System Description 19 for Senec.Home V3 Hybrid (Credits to noffycws)
* Added Mode Descriptions for 86-91. (Credits to noffycws)

### 1.0.12 (NoBl)
* Just set 'supportCustoms' to false so it won't show up in admin custom config.

### 1.0.11 (NoBl)
* Update to current adapter template
* Added Datapoints: PV1.MPP_CUR, MPP_VOL, MPP_POWER (former: MPP_INT which is unused at this moment but does still exist)
* Added Datapoints (please feedback any improvements for their descriptions, ...): FEATURES.SGREADY, WIZARD.SETUP_WALLBOX_MAX_TOTAL_CURRENT_BY_GRID, WIZARD.SG_READY_CURR_MODE, BMS.ERROR, BMS.RECOVERLOCKED, BMS.SERIAL, BMS.START_SELFTEST, BAT1.RESET, BAT1.SELFTEST_ACT, BAT1.SELFTEST_LIMIT, BAT1.SELFTEST_OFF, BAT1.SELFTEST_OVERALL_STATE, BAT1.SELFTEST_STATE, BAT1.SELFTEST_STEP, BAT1.SELFTEST_TIME, BAT1.SERIAL, BAT1.TRIG_ITALY_SELF, BAT1OBJ1.COMM, GRIDCONFIG.AU_SOFT_RAMP_EN, GRIDCONFIG.AU_VRR_MAX, GRIDCONFIG.AU_VRR_MIN, GRIDCONFIG.AU_VVAR_PERCENTAGE, GRIDCONFIG.AU_VVAR_P_MAX, GRIDCONFIG.AU_VVAR_P_MIN, GRIDCONFIG.AU_VVAR_VOLTAGE, GRIDCONFIG.AU_VWC_VOLTAGE, GRIDCONFIG.AU_VWD_VOLTAGE, GRIDCONFIG.CEI_SEGNALE_ESTERNO, GRIDCONFIG.VDELVFRTDISABLE, GRIDCONFIG.VDEURMSMAX10

### 1.0.10 (NoBl, smartpran)
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

### 1.0.9 (NoBl)
* IP types are shown as IP again.
* added datapoints for FACTORY along with more state descriptions for Battery Type, Country and System Type.
* added datapoints for GRIDCONFIG

### 1.0.8 (NoBl)
* Added more states to known states (please feedback if they need special handling (unit, special description, value modification, ...))
* Bugfix in creating debug data
* Unknown states are now reported in debug instead of info.
* Code cleanup

### 1.0.7 (NoBl)
* Reading all known states from SENEC.
* Split states into high/low priority (heavy requesting the SENEC system renders it unable to sync with the SENEC datacenter!).
* Updated adapter-core and testing versions along with current dev dependencies. Removed node 8 support.
* Added more state descriptions to manual. But need input on these and those that are still not documented.

### 1.0.6 (NoBl)
* Moved senec states and state attributes to libs
* Added missing state descriptions

### 1.0.5 (2020-03-07) (NoBl)
* Added States for: Energy: GUI_BAT_DATA_VOLTAGE, GUI_BAT_DATA_CURRENT, STAT_HOURS_OF_OPERATION; Sys_update: NPU_VER, NPU_IMAGE_VERSION, Wizard: APPLICATION_VERSION, INTERFACE_VERSION
* Readme and Documentation (EN exists, now) updated
* Changed behavior for unknown values completely. They will now be stored as string plus prefixed with "REPORT TO DEV:" so users can easily report back what needs updating.
* added handling for "st_" values in json
* added additional configuration options
* changed retry-behaviour in case of connection issues, ...

### 1.0.4 (2020-03-06)
* (NoBl) Repo URL updated

### 1.0.3 (2020-03-06)
* (NoBl) added link to documentation in german

### 1.0.2 (2020-03-04)
* (NoBl) added missing status codes (85 in total now)
* (NoBl) added status code to status message for easier reference
* (NoBl) added states for wallboxes and battery modules

### 1.0.1
* (NoBl) updated readme

### 1.0.0
* (NoBl) initial release
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