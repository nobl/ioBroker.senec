![Logo](admin/senec.png)
# ioBroker.senec

[![NPM version](http://img.shields.io/npm/v/iobroker.senec.svg)](https://www.npmjs.com/package/iobroker.senec)
[![Downloads](https://img.shields.io/npm/dm/iobroker.senec.svg)](https://www.npmjs.com/package/iobroker.senec)
[![Dependency Status](https://img.shields.io/david/nobl/iobroker.senec.svg)](https://david-dm.org/nobl/iobroker.senec)
[![Known Vulnerabilities](https://snyk.io/test/github/nobl/ioBroker.senec/badge.svg)](https://snyk.io/test/github/nobl/ioBroker.senec)

[![NPM](https://nodei.co/npm/iobroker.senec.png?downloads=true)](https://nodei.co/npm/iobroker.senec/)

**Tests:**: [![Travis-CI](http://img.shields.io/travis/nobl/ioBroker.senec/master.svg)](https://travis-ci.org/nobl/ioBroker.senec)

## senec adapter for ioBroker
Targeted at the Senec Home V2.1 System.
Other systems might work, as long as they use lala.cgi.

## Installation
You can either install the adapter via the ioBroker web interface or on your local machine via npm.

### Browser-based
1. Open your ioBroker web interface in a browser (eg: 192.168.178.42:8081)
2. Click on Tab "Adapters"
3. Type "senec" in the filter
4. Click on the  "+" symbol of the senec adapter

### Local machine
Navigate into your iobroker folder and execute the following command: 
```bash
npm i iobroker.senec
```

## Setup
Additional to the adapter installation you have to add an instance of the adapter.

### ioBroker 
1. Open your ioBroker interface in a browser (eg: 192.168.178.42:8081)
2. Navigate to Tab "Instances"
3. Click on the wrench symbol of the senec adapter
4. Now you can see the main settings of the adapter configuration page --> type in the ip-address of your senec system (FQDN is also possible if you have a working local DNS)<br>
![Main Settings](/docs/de/media/mainSettings.png)
5. If you want to thange the interval in which the states are polled, you can change this here, too.
6. The default polling interval 10 seconds
7. Click on Save & Close

## Usage
Here you can find a description of the states and how to use them. All states of this adapter are read-only states.

### States

#### Channel: info

* info.connection

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *Read-only boolean which is true if the adapter is connected to the senec system.*
   

#### Channel: ENERGY
   
* GUI_BAT_DATA_FUEL_CHARGE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the current level of your battery system in %.*
   
* GUI_BAT_DATA_POWER

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents how much power is coming from / going into the battery in Watts. Negative values are discharging.*
   
* GUI_BOOSTING_INFO

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *Read-only boolean, which we don't know the exact meaning of yet.*
   
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
   
* STAT_MAINT_REQUIRED

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *Read-only boolean, which represents if your senec system requires maintenance.*
   
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
   
#### Channel: STATISTIC

* STAT_DAY_BAT_CHARGE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the amount of power charged into the battery in kWh today.*
   
* STAT_DAY_BAT_DISCHARGE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the amount of power drawn from the battery in kWh today.*
   
* STAT_DAY_E_GRID_EXPORT

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the amount of power in kWh delivered into the net today.*
   
* STAT_DAY_E_GRID_IMPORT

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the amount of power in kWh drawn from the net today.*
   
* STAT_DAY_E_HOUSE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the amount of power in kWh consumed by the house today.*
   
* STAT_DAY_E_PV

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |number|R|

   *Read-only number, which represents the amount of power in kWh generated by your PV today.*
   
   
#### Channel: SYS_UPDATE

* UPDATE_AVAILABLE

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *boolean-value which is true if there is an update available (Updates happen automatically and are scheduled by SENEC).*
   
   
#### Channel: WIZARD

* CONFIG_LOADED

    |Data type|Permission|                                                                       
    |:---:|:---:|
    |boolean|R|

   *boolean-value which is true if configuration is loaded. This being false is very unlikely and it shouldn't persist as false.*

## Changelog

### 1.0.1
* (NoBl) updated readme
### 1.0.0
* (NoBl) initial release

## License
MIT License

Copyright (c) 2020 Norbert Bluemle <github@bluemle.org>

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