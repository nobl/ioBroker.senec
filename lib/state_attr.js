// State attributes

const state_attr = {
    'ENERGY.STAT_STATE': {
        name: 'System Mode',
        unit: '',
        booltype: false,
    },
    'ENERGY.STAT_STATE_Text': {
        name: 'System Mode',
        unit: '',
        booltype: false,
    },
    'ENERGY.GUI_BAT_DATA_FUEL_CHARGE': {
        name: 'Accu Level',
        unit: '%',
        booltype: false,
    },
    'ENERGY.GUI_INVERTER_POWER': {
        name: 'PV Power current',
        unit: 'W',
        booltype: false,
    },
    'ENERGY.GUI_GRID_POW': {
        name: 'Net Power current',
        unit: 'W',
        booltype: false,
    },
    'ENERGY.GUI_BAT_DATA_POWER': {
        name: 'Accu Power current',
        unit: 'W',
        booltype: false,
    },
    'ENERGY.GUI_HOUSE_POW': {
        name: 'House Power current',
        unit: 'W',
        booltype: false,
    },
    'ENERGY.GUI_CHARGING_INFO': {
        name: 'Accu charging',
        unit: '',
        booltype: true,
    },
    'ENERGY.GUI_BOOSTING_INFO': {
        name: 'Boost',
        unit: '',
        booltype: true,
    },
    'ENERGY.STAT_MAINT_REQUIRED': {
        name: 'Maintenance required',
        unit: '',
        booltype: true,
    },
    'ENERGY.GUI_BAT_DATA_VOLTAGE': {
        name: 'Battery Voltage',
        unit: 'V',
        booltype: false,
    },
    'ENERGY.GUI_BAT_DATA_CURRENT': {
        name: 'Battery Current',
        unit: 'A',
        booltype: false,
    },
    'ENERGY.STAT_HOURS_OF_OPERATION': {
        name: 'Hours of operation',
        unit: 'h',
        booltype: false,
    },
    'STATISTIC.STAT_DAY_E_PV': {
        name: 'PV Power Day',
        type: 'kWh',
        booltype: false,
    },
    'STATISTIC.STAT_DAY_E_GRID_IMPORT': {
        name: 'Net Import Day',
        type: 'kWh',
        booltype: false,
    },
    'STATISTIC.STAT_DAY_E_GRID_EXPORT': {
        name: 'Net Export Day',
        type: 'kWh',
        booltype: false,
    },
    'STATISTIC.STAT_DAY_BAT_CHARGE': {
        name: 'Accu Charged Day',
        type: 'kWh',
        booltype: false,
    },
    'STATISTIC.STAT_DAY_BAT_DISCHARGE': {
        name: 'Accu Discharged Day',
        type: 'kWh',
        booltype: false,
    },
    'STATISTIC.STAT_DAY_E_HOUSE': {
        name: 'House Power Day',
        type: 'kWh',
        booltype: false,
    },
    'SYS_UPDATE.NPU_IMAGE_VERSION': {
        name: 'Revision NPU-Image',
        unit: '',
        booltype: false,
    },
    'SYS_UPDATE.NPU_VER': {
        name: 'Revision NPU-REGS',
        unit: '',
        booltype: false,
    },
    'SYS_UPDATE.UPDATE_AVAILABLE': {
        name: 'Update available',
        unit: '',
        booltype: true,
    },
    'WIZARD.APPLICATION_VERSION': {
        name: 'Revision MCU',
        unit: '',
        booltype: false,
    },
    'WIZARD.CONFIG_LOADED': {
        name: 'Configuration loaded',
        unit: '',
        booltype: true,
    },
    'WIZARD.INTERFACE_VERSION': {
        name: 'Revision GUI',
        unit: '',
        booltype: false,
    },
    'WIZARD.SETUP_NUMBER_WALLBOXES': {
        name: '# Wallboxes',
        unit: '',
        booltype: false,
    },
    'WIZARD.SETUP_WALLBOX_SERIAL0': {
        name: 'Wallbox 0 Serial',
        unit: '',
        booltype: false,
    },
    'WIZARD.SETUP_WALLBOX_SERIAL1': {
        name: 'Wallbox 1 Serial',
        unit: '',
        booltype: false,
    },
    'WIZARD.SETUP_WALLBOX_SERIAL2': {
        name: 'Wallbox 2 Serial',
        unit: '',
        booltype: false,
    },
    'WIZARD.SETUP_WALLBOX_SERIAL3': {
        name: 'Wallbox 3 Serial',
        unit: '',
        booltype: false,
    },
    'BMS.MODULE_COUNT': {
        name: '# Modules',
        unit: '',
        booltype: false,
    },
    'BMS.MODULES_CONFIGURED': {
        name: '# Modules Configured',
        unit: '',
        booltype: false,
    },

}

module.exports = state_attr;
