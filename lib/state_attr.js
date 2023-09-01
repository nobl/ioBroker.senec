// State attributes

const state_attr = {
	'_calc.Autarky.today': {
		name: 'Autarky - Today',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.yesterday': {
		name: 'Autarky - Yesterday',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.week': {
		name: 'Autarky - Week',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.lastWeek': {
		name: 'Autarky - Last Week',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.month': {
		name: 'Autarky - Month',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.lastMonth': {
		name: 'Autarky - Last Month',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.year': {
		name: 'Autarky - Year',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.lastYear': {
		name: 'Autarky - Last Year',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.refDay': {
		name: 'Autarky - Reference Day',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.refWeek': {
		name: 'Autarky - Reference Week',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.refMonth': {
		name: 'Autarky - Reference Month',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
	'_calc.Autarky.refYear': {
		name: 'Autarky - Reference Year',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.today': {
		name: 'Exported to grid - Today',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.yesterday': {
		name: 'Exported to grid - Yesterday',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.refValue': {
		name: 'Exported to grid - Reference Value',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.refDay': {
		name: 'Exported to grid - Reference Day',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.today': {
		name: 'Imported from grid - Today',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.yesterday': {
		name: 'Imported from grid - Yesterday',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.refValue': {
		name: 'Imported from grid - Reference Value',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.refDay': {
		name: 'Imported from grid - Reference Day',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.today': {
		name: 'House Consumption - Today',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.yesterday': {
		name: 'House Consumption - Yesterday',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.refValue': {
		name: 'House Consumption - Reference Value',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.refDay': {
		name: 'House Consumption - Reference Day',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.today': {
		name: 'Generated Power - Today',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.yesterday': {
		name: 'Generated Power - Yesterday',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.refValue': {
		name: 'Generated Power - Reference Value',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.refDay': {
		name: 'Generated Power - Reference Day',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.today': {
		name: 'Battery Charged - Today',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.yesterday': {
		name: 'Battery Charged - Yesterday',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.refValue': {
		name: 'Battery Charged - Reference Value',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.refDay': {
		name: 'Battery Charged - Reference Day',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.today': {
		name: 'Battery Discharged - Today',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.yesterday': {
		name: 'Battery Discharged - Yesterday',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.refValue': {
		name: 'Battery Discharged - Reference Value',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.refDay': {
		name: 'Battery Discharged - Reference Day',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},	
    '_calc.LIVE_GRID_EXPORT.week': {
		name: 'Exported to grid - Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.lastWeek': {
		name: 'Exported to grid - Last Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.refValueWeek': {
		name: 'Exported to grid - Reference Value Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.refWeek': {
		name: 'Exported to grid - Reference Week',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.week': {
		name: 'Imported from grid - Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.lastWeek': {
		name: 'Imported from grid - Last Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.refValueWeek': {
		name: 'Imported from grid - Reference Value Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.refWeek': {
		name: 'Imported from grid - Reference Week',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.week': {
		name: 'House Consumption - Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.lastWeek': {
		name: 'House Consumption - Last Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.refValueWeek': {
		name: 'House Consumption - Reference Value Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.refWeek': {
		name: 'House Consumption - Reference Week',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.week': {
		name: 'Generated Power - Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.lastWeek': {
		name: 'Generated Power - Last Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.refValueWeek': {
		name: 'Generated Power - Reference Value Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.refWeek': {
		name: 'Generated Power - Reference Week',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.week': {
		name: 'Battery Charged - Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.lastWeek': {
		name: 'Battery Charged - Last Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.refValueWeek': {
		name: 'Battery Charged - Reference Value Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.refWeek': {
		name: 'Battery Charged - Reference Week',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.week': {
		name: 'Battery Discharged - Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.lastWeek': {
		name: 'Battery Discharged - Last Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.refValueWeek': {
		name: 'Battery Discharged - Reference Value Week',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.refWeek': {
		name: 'Battery Discharged - Reference Week',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},	
    '_calc.LIVE_GRID_EXPORT.month': {
		name: 'Exported to grid - Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.lastMonth': {
		name: 'Exported to grid - Last Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.refValueMonth': {
		name: 'Exported to grid - Reference Value for Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.refMonth': {
		name: 'Exported to grid - Reference Month',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.month': {
		name: 'Imported from grid - Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.lastMonth': {
		name: 'Imported from grid - Last Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.refValueMonth': {
		name: 'Imported from grid - Reference Value Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.refMonth': {
		name: 'Imported from grid - Reference Month',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.month': {
		name: 'House Consumption - Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.lastMonth': {
		name: 'House Consumption - Last Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.refValueMonth': {
		name: 'House Consumption - Reference Value Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.refMonth': {
		name: 'House Consumption - Reference Month',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.month': {
		name: 'Generated Power - Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.lastMonth': {
		name: 'Generated Power - Last Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.refValueMonth': {
		name: 'Generated Power - Reference Value Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.refMonth': {
		name: 'Generated Power - Reference Month',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.month': {
		name: 'Battery Charged - Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.lastMonth': {
		name: 'Battery Charged - Last Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.refValueMonth': {
		name: 'Battery Charged - Reference Value Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.refMonth': {
		name: 'Battery Charged - Reference Month',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.month': {
		name: 'Battery Discharged - Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.lastMonth': {
		name: 'Battery Discharged - Last Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.refValueMonth': {
		name: 'Battery Discharged - Reference Value Month',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.refMonth': {
		name: 'Battery Discharged - Reference Month',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.year': {
		name: 'Exported to grid - Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.lastYear': {
		name: 'Exported to grid - Last Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.refValueYear': {
		name: 'Exported to grid - Reference Value for Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_EXPORT.refYear': {
		name: 'Exported to grid - Reference Year',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.year': {
		name: 'Imported from grid - Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.lastYear': {
		name: 'Imported from grid - Last Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.refValueYear': {
		name: 'Imported from grid - Reference Value Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_GRID_IMPORT.refYear': {
		name: 'Imported from grid - Reference Year',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.year': {
		name: 'House Consumption - Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.lastYear': {
		name: 'House Consumption - Last Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.refValueYear': {
		name: 'House Consumption - Reference Value Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_HOUSE_CONS.refYear': {
		name: 'House Consumption - Reference Year',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.year': {
		name: 'Generated Power - Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.lastYear': {
		name: 'Generated Power - Last Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.refValueYear': {
		name: 'Generated Power - Reference Value Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_PV_GEN.refYear': {
		name: 'Generated Power - Reference Year',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.year': {
		name: 'Battery Charged - Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.lastYear': {
		name: 'Battery Charged - Last Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.refValueYear': {
		name: 'Battery Charged - Reference Value Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_CHARGE_MASTER.refYear': {
		name: 'Battery Charged - Reference Year',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.year': {
		name: 'Battery Discharged - Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.lastYear': {
		name: 'Battery Discharged - Last Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.refValueYear': {
		name: 'Battery Discharged - Reference Value Year',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    '_calc.LIVE_BAT_DISCHARGE_MASTER.refYear': {
		name: 'Battery Discharged - Reference Year',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
	},
    'BAT1.BATTERIES_MISSING': {
        name: 'BATTERIES_MISSING',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.DRM0_ASSERT': {
        name: 'DRM0_ASSERT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1.CEI_LIMIT': {
        name: 'CEI_LIMIT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1.ISLAND_ENABLE': {
        name: 'ISLAND_ENABLE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1.NSP_FW': {
        name: 'NSP_FW',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1.NSP2_FW': {
        name: 'NSP2_FW',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1.REQ_HV_UPD': {
        name: 'REQ_HV_UPD',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1.REQ_LV_UPD': {
        name: 'REQ_LV_UPD',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.RESET': {
        name: 'Bat1 Reset',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.SELFTEST_ACT': {
        name: 'Bat1 Selftest ACT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.SELFTEST_LIMIT': {
        name: 'Bat1 Selftest Limit',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.SELFTEST_OFF': {
        name: 'Bat1 Selftest Off',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.SELFTEST_OVERALL_STATE': {
        name: 'Bat1 Selftest Overall State',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.SELFTEST_STATE': {
        name: 'Bat1 Selftest State',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.SELFTEST_STEP': {
        name: 'Bat1 Selftest Step',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.SELFTEST_TIME': {
        name: 'Bat1 Selftest Time',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.SERIAL': {
        name: 'Bat1 Serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1.SPARE_CAPACITY': {
        name: 'SPARE_CAPACITY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1.TRIG_ITALY_SELF': {
        name: 'Bat1 Trig Italy Self',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1.TYPE': {
        name: 'TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.ADR': {
        name: 'ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_ALARM_STATUS': {
        name: 'BMS_ALARM_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_BATTERY_SOC': {
        name: 'BMS_BATTERY_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_BATTERY_STATUS': {
        name: 'BMS_BATTERY_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_MAX_TEMP': {
        name: 'BMS_MAX_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.1
    },
    'BAT1OBJ1.BMS_MIN_TEMP': {
        name: 'BMS_MIN_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.1
    },
    'BAT1OBJ1.BMS_NR_ACTIVE': {
        name: 'BMS_NR_ACTIVE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_NR_CHARGE': {
        name: 'BMS_NR_CHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_NR_DISCHARGE': {
        name: 'BMS_NR_DISCHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_NR_INSTALLED': {
        name: 'BMS_NR_INSTALLED',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_SW_VER': {
        name: 'BMS_SW_VER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_SYSTEM_SOC': {
        name: 'BMS_SYSTEM_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.1
    },
    'BAT1OBJ1.BMS_TOTAL_CURRENT': {
        name: 'BMS_TOTAL_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.BMS_TOTAL_VOLTAGE': {
        name: 'BMS_TOTAL_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BAT1OBJ1.COMM': {
        name: 'COMM',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.ENABLED': {
        name: 'ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.ERROR': {
        name: 'ERROR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.INV_CYCLE': {
        name: 'INV_CYCLE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.I_DC': {
        name: 'I_DC',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.I_DC_MAX': {
        name: 'I_DC_MAX',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.P': {
        name: 'P',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.Q': {
        name: 'Q',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.S': {
        name: 'S',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.STATE': {
        name: 'STATE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.SPECIAL_TIMEOUT': {
        name: 'SPECIAL_TIMEOUT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.SW_VERSION': {
        name: 'SW_VERSION',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.SW_VERSION2': {
        name: 'SW_VERSION2',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.SW_VERSION3': {
        name: 'SW_VERSION3',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.TEMP1': {
        name: 'TEMP1',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.TEMP2': {
        name: 'TEMP2',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.TEMP3': {
        name: 'TEMP3',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.TEMP4': {
        name: 'TEMP4',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.TEMP5': {
        name: 'TEMP5',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ1.U_DC': {
        name: 'U_DC',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.ADR': {
        name: 'ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_ALARM_STATUS': {
        name: 'BMS_ALARM_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_BATTERY_SOC': {
        name: 'BMS_BATTERY_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_BATTERY_STATUS': {
        name: 'BMS_BATTERY_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_MAX_TEMP': {
        name: 'BMS_MAX_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_MIN_TEMP': {
        name: 'BMS_MIN_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_NR_ACTIVE': {
        name: 'BMS_NR_ACTIVE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_NR_CHARGE': {
        name: 'BMS_NR_CHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_NR_DISCHARGE': {
        name: 'BMS_NR_DISCHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_NR_INSTALLED': {
        name: 'BMS_NR_INSTALLED',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_SW_VER': {
        name: 'BMS_SW_VER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_SYSTEM_SOC': {
        name: 'BMS_SYSTEM_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_TOTAL_CURRENT': {
        name: 'BMS_TOTAL_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.BMS_TOTAL_VOLTAGE': {
        name: 'BMS_TOTAL_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.ENABLED': {
        name: 'ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.ERROR': {
        name: 'ERROR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.INV_CYCLE': {
        name: 'INV_CYCLE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.I_DC': {
        name: 'I_DC',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.I_DC_MAX': {
        name: 'I_DC_MAX',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.P': {
        name: 'P',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.Q': {
        name: 'Q',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.S': {
        name: 'S',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.SPECIAL_TIMEOUT': {
        name: 'SPECIAL_TIMEOUT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.STATE': {
        name: 'STATE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.SW_VERSION': {
        name: 'SW_VERSION',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.SW_VERSION2': {
        name: 'SW_VERSION2',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.SW_VERSION3': {
        name: 'SW_VERSION3',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.TEMP1': {
        name: 'TEMP1',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.TEMP2': {
        name: 'TEMP2',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.TEMP3': {
        name: 'TEMP3',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.TEMP4': {
        name: 'TEMP4',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.TEMP5': {
        name: 'TEMP5',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ2.U_DC': {
        name: 'U_DC',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.ADR': {
        name: 'ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_ALARM_STATUS': {
        name: 'BMS_ALARM_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_BATTERY_SOC': {
        name: 'BMS_BATTERY_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_BATTERY_STATUS': {
        name: 'BMS_BATTERY_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_MAX_TEMP': {
        name: 'BMS_MAX_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_MIN_TEMP': {
        name: 'BMS_MIN_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_NR_ACTIVE': {
        name: 'BMS_NR_ACTIVE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_NR_CHARGE': {
        name: 'BMS_NR_CHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_NR_DISCHARGE': {
        name: 'BMS_NR_DISCHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_NR_INSTALLED': {
        name: 'BMS_NR_INSTALLED',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_SW_VER': {
        name: 'BMS_SW_VER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_SYSTEM_SOC': {
        name: 'BMS_SYSTEM_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_TOTAL_CURRENT': {
        name: 'BMS_TOTAL_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.BMS_TOTAL_VOLTAGE': {
        name: 'BMS_TOTAL_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.ENABLED': {
        name: 'ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.ERROR': {
        name: 'ERROR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.INV_CYCLE': {
        name: 'INV_CYCLE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.I_DC': {
        name: 'I_DC',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.I_DC_MAX': {
        name: 'I_DC_MAX',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.P': {
        name: 'P',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.Q': {
        name: 'Q',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.S': {
        name: 'S',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.SPECIAL_TIMEOUT': {
        name: 'SPECIAL_TIMEOUT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.STATE': {
        name: 'STATE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.SW_VERSION': {
        name: 'SW_VERSION',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.SW_VERSION2': {
        name: 'SW_VERSION2',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.SW_VERSION3': {
        name: 'SW_VERSION3',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.TEMP1': {
        name: 'TEMP1',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.TEMP2': {
        name: 'TEMP2',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.TEMP3': {
        name: 'TEMP3',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.TEMP4': {
        name: 'TEMP4',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.TEMP5': {
        name: 'TEMP5',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ3.U_DC': {
        name: 'U_DC',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.ADR': {
        name: 'ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_ALARM_STATUS': {
        name: 'BMS_ALARM_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_BATTERY_SOC': {
        name: 'BMS_BATTERY_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_BATTERY_STATUS': {
        name: 'BMS_BATTERY_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_MAX_TEMP': {
        name: 'BMS_MAX_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_MIN_TEMP': {
        name: 'BMS_MIN_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_NR_ACTIVE': {
        name: 'BMS_NR_ACTIVE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_NR_CHARGE': {
        name: 'BMS_NR_CHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_NR_DISCHARGE': {
        name: 'BMS_NR_DISCHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_NR_INSTALLED': {
        name: 'BMS_NR_INSTALLED',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_SW_VER': {
        name: 'BMS_SW_VER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_SYSTEM_SOC': {
        name: 'BMS_SYSTEM_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_TOTAL_CURRENT': {
        name: 'BMS_TOTAL_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.BMS_TOTAL_VOLTAGE': {
        name: 'BMS_TOTAL_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.ENABLED': {
        name: 'ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.INV_CYCLE': {
        name: 'INV_CYCLE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.I_DC': {
        name: 'I_DC',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.I_DC_MAX': {
        name: 'I_DC_MAX',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.SPECIAL_TIMEOUT': {
        name: 'SPECIAL_TIMEOUT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.SW_VERSION': {
        name: 'SW_VERSION',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.TEMP1': {
        name: 'TEMP1',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.TEMP2': {
        name: 'TEMP2',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.TEMP3': {
        name: 'TEMP3',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.TEMP4': {
        name: 'TEMP4',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.TEMP5': {
        name: 'TEMP5',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BAT1OBJ4.U_DC': {
        name: 'U_DC',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.ALARM_STATUS': {
        name: 'ALARM_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.ALLOWRECOVER': {
        name: 'ALLOWRECOVER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.BATTERY_STATUS': {
        name: 'BATTERY_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.BL': {
        name: 'BL',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
      'BMS.CELL_BALANCE_STATUS': {
        name: 'CELL_BALANCE_STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },    
      'BMS.CELL_TEMPERATURES_MODULE_A': {
        name: 'CELL_TEMPERATURES_MODULE_A',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },  
      'BMS.CELL_TEMPERATURES_MODULE_B': {
        name: 'CELL_TEMPERATURES_MODULE_B',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    }, 
      'BMS.CELL_TEMPERATURES_MODULE_C': {
        name: 'CELL_TEMPERATURES_MODULE_C',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    }, 
      'BMS.CELL_TEMPERATURES_MODULE_D': {
        name: 'CELL_TEMPERATURES_MODULE_D',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    }, 
      'BMS.CELL_VOLTAGES_MODULE_A': {
        name: 'CELL_VOLTAGES_MODULE_A',
        unit: 'mV',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    }, 
      'BMS.CELL_VOLTAGES_MODULE_B': {
        name: 'CELL_VOLTAGES_MODULE_V',
        unit: 'mV',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    }, 
      'BMS.CELL_VOLTAGES_MODULE_C': {
        name: 'CELL_VOLTAGES_MODULE_C',
        unit: 'mV',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    }, 
      'BMS.CELL_VOLTAGES_MODULE_D': {
        name: 'CELL_VOLTAGES_MODULE_D',
        unit: 'mV',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.BMS_READY_FLAG': {
        name: 'BMS Ready Flag',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.CHARGED_ENERGY': {
        name: 'Charged Energy',
        unit: '?',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.CHARGE_CURRENT_LIMIT': {
        name: 'Charge Current Limit',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.COMMERRCOUNT': {
        name: 'COMMERRCOUNT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.CURRENT': {
        name: 'Current',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.CYCLES': {
        name: 'Cycles',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.DERATING': {
        name: 'DERATING',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.DISCHARGED_ENERGY': {
        name: 'Discharged Energy',
        unit: '?',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.DISCHARGE_CURRENT_LIMIT': {
        name: 'Discharge current limit',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BMS.ERROR': {
        name: 'BMS Error',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.FAULTLINECOUNT': {
        name: 'FAULTLINECOUNT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.FW': {
        name: 'FW',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.HW_EXTENSION': {
        name: 'HW Extension',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.HW_MAINBOARD': {
        name: 'HW Mainboard',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BMS.MANUFACTURER': {
        name: 'Manufacturer',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.MAX_CELL_VOLTAGE': {
        name: 'Max Cell Voltage',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.01
    },
    'BMS.MAX_TEMP': {
        name: 'MAX_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.1
    },
    'BMS.MIN_CELL_VOLTAGE': {
        name: 'Min Cell Voltage',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.01
    },
    'BMS.MIN_TEMP': {
        name: 'MIN_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.1
    },
    'BMS.MODULE_COUNT': {
        name: '# Modules',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.MODULES_CONFIGURED': {
        name: '# Modules Configured',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BMS.NOM_CHARGEPOWER_MODULE': {
        name: 'Nominal Chargepower Module',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BMS.NOM_DISCHARGEPOWER_MODULE': {
        name: 'Nominal Dischargepower Module',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.NR_ACTIVE': {
        name: 'NR_ACTIVE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.NR_CHARGE': {
        name: 'NR_CHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.NR_DISCHARGE': {
        name: 'NR_DISCHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.NR_INSTALLED': {
        name: 'NR_INSTALLED',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.PROTOCOL': {
        name: 'PROTOCOL',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BMS.RECOVERLOCKED': {
        name: 'BMS Recover Locked',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BMS.SERIAL': {
        name: 'BMS Serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.SN': {
        name: 'SN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.SOC': {
        name: 'SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.SOH': {
        name: 'SOH',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.START_RL_TST': {
        name: 'START_RL_TST',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BMS.START_SELFTEST': {
        name: 'BMS Start Selftest',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.START_UPDATE': {
        name: 'Start Update',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.BMS_STATUS': {
        name: 'BMS Status',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.BMS_STATUS_TIMESTAMP': {
        name: 'BMS Status Timestamp',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.STATUS': {
        name: 'Status',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.SYSTEM_SOC': {
        name: 'SYSTEM_SOC',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.1
    },
    'BMS.TEMP_MAX': {
        name: 'Temp Max',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.TEMP_MIN': {
        name: 'Temp Min',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'BMS.TF_ERROR': {
		name: 'TF Error',
		unit: '',
		booltype: true,
		datetype: false,
		iptype: false,
		multiply: 1
	},
    'BMS.TOTAL_CURRENT': {
        name: 'TOTAL_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.TOTAL_VOLTAGE': {
        name: 'TOTAL_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.VOLTAGE': {
        name: 'Voltage',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.WIZARD_ABORT': {
        name: 'Wizard Abort',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.WIZARD_CONFIRM': {
        name: 'Wizard Confirm',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.WIZARD_DCCONNECT': {
        name: 'Wizard DC Connect',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.WIZARD_START': {
        name: 'Wizard Start',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'BMS.WIZARD_STATE': {
        name: 'Wizard State',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.BATPOWERSUM': {
        name: 'Battery power sum',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.POWER': {
        name: 'Power',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.POWER0': {
        name: 'CASC.POWER0',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.POWER1': {
        name: 'CASC.POWER1',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.POWER2': {
        name: 'CASC.POWER2',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.POWER3': {
        name: 'CASC.POWER3',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.POWER4': {
		name: 'CASC.POWER4',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.POWER5': {
        name: 'CASC.POWER5',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.PVGEN': {
        name: 'PV generation',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.PVMASTER': {
        name: 'PV master',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.SOC': {
        name: 'SOC (State of charge)',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.SOC0': {
        name: 'CASC.SOC0',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.SOC1': {
        name: 'CASC.SOC1',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.SOC2': {
        name: 'CASC.SOC2',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.SOC3': {
        name: 'CASC.SOC3',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.SOC4': {
        name: 'CASC.SOC4',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.SOC5': {
        name: 'CASC.SOC5',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.STATE': {
		name: 'State',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.STATE0': {
		name: 'CASC.STATE0',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.STATE1': {
        name: 'CASC.STATE1',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.STATE2': {
        name: 'CASC.STATE2',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.STATE3': {
        name: 'CASC.STATE3',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.STATE4': {
        name: 'CASC.STATE4',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.STATE5': {
        name: 'CASC.STATE5',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.TARGET': {
        name: 'Target',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.TARGET0': {
        name: 'CASC.TARGET0',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.TARGET1': {
        name: 'CASC.TARGET1',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.TARGET2': {
        name: 'CASC.TARGET2',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.TARGET3': {
        name: 'CASC.TARGET3',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.TARGET4': {
        name: 'CASC.TARGET4',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'CASC.TARGET5': {
        name: 'CASC.TARGET5',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.CHARGE_TARGET': {
        name: 'DEBUG.CHARGE_TARGET',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.DC_TARGET': {
        name: 'DEBUG.DC_TARGET',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.DC_TARGET_PID_KD': {
        name: 'DEBUG.DC_TARGET_PID_KD',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.DC_TARGET_PID_KI': {
        name: 'DEBUG.DC_TARGET_PID_KI',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.DC_TARGET_PID_KP': {
        name: 'DEBUG.DC_TARGET_PID_KP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.EG_POT_BOOST_CAP': {
        name: 'DEBUG.EG_POT_BOOST_CAP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.EG_POT_BOOST_POW': {
        name: 'DEBUG.EG_POT_BOOST_POW',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.EG_POT_CHARGE_CAP': {
        name: 'DEBUG.EG_POT_CHARGE_CAP',
        unit: 'Wh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.EG_POT_CHARGE_POW': {
        name: 'DEBUG.EG_POT_CHARGE_POW',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.EX_DUMP': {
        name: 'DEBUG.EX_DUMP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.EX_DUMP_FILE': {
        name: 'DEBUG.EX_DUMP_FILE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.FEED_TARGET': {
        name: 'DEBUG.FEED_TARGET',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.INFO_DUMP': {
        name: 'DEBUG.INFO_DUMP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.PU_AVAIL': {
        name: 'DEBUG.PU_AVAIL',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.RAM_DUMP': {
        name: 'DEBUG.RAM_DUMP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.SECTIONS': {
        name: 'Sections',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'DEBUG.STACK_MONITOR': {
        name: 'DEBUG.STACK_MONITOR',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'EG_CONTROL.ACTIVE': {
        name: 'EG_CONTROL.ACTIVE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.EG_MTR_ERROR': {
        name: 'EG_CONTROL.EG_MTR_ERROR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.EG_SW_ERROR': {
        name: 'EG_CONTROL.EG_SW_ERROR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.ERROR_EG_METER': {
        name: 'EG_CONTROL.ERROR_EG_METER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.ERROR_EG_SWITCH': {
        name: 'EG_CONTROL.ERROR_EG_SWITCH',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.POWER_METER_INFO_RES': {
        name: 'EG_CONTROL.POWER_METER_INFO_RES',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.POWER_METER_INFO_TRIG': {
        name: 'EG_CONTROL.POWER_METER_INFO_TRIG',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.POWER_METER_SERIAL': {
        name: 'EG_CONTROL.POWER_METER_SERIAL',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.TEST_EG_METER_RES': {
        name: 'EG_CONTROL.TEST_EG_METER_RES',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.TEST_EG_METER_TRIG': {
        name: 'EG_CONTROL.TEST_EG_METER_TRIG',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.TEST_EG_SWITCH_RES': {
        name: 'EG_CONTROL.TEST_EG_SWITCH_RES',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'EG_CONTROL.TEST_EG_SWITCH_TRIG': {
        name: 'EG_CONTROL.TEST_EG_SWITCH_TRIG',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'ENERGY.FORCE_FULL_CHARGE': {
        name: 'Force Full Charge',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.CAPTESTMODULE': {
        name: 'Capacity Test Module',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GRID_POWER_OFFSET': {
        name: 'GRID_POWER_OFFSET',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_CAPACITY': {
        name: 'GUI_BAT_DATA_CAPACITY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_COLLECTED': {
        name: 'GUI_BAT_DATA_COLLECTED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_CURRENT': {
        name: 'Battery Current',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_FUEL_CHARGE': {
        name: 'Accu Level',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_POWER': {
        name: 'Accu Power current',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_MAX_CELL_VOLTAGE': {
        name: 'BAT_DATA_MAX_CELL_VOLTAGE',
        unit: 'mV',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_MIN_CELL_VOLTAGE': {
        name: 'BAT_DATA_MIN_CELL_VOLTAGE',
        unit: 'mV',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_OA_CHARGING': {
        name: 'BAT_DATA_OA_CHARGING',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_OA_ENERGY': {
        name: 'GUI_BAT_DATA_OA_ENERGY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BAT_DATA_VOLTAGE': {
        name: 'Battery Voltage',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_BOOSTING_INFO': {
        name: 'Boost',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_CAP_TEST_DIS_COUNT': {
        name: 'CAP_TEST_DIS_COUNT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_CAP_TEST_START': {
        name: 'GUI_CAP_TEST_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_CAP_TEST_STATE': {
        name: 'GUI_CAP_TEST_STATE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_CAP_TEST_STOP': {
        name: 'GUI_CAP_TEST_STOP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_CHARGING_INFO': {
        name: 'Accu charging',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_EQUAL_CHARGE_RUN': {
        name: 'GUI_EQUAL_CHARGE_RUN',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_EQUAL_CHARGE_START': {
        name: 'GUI_EQUAL_CHARGE_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_EQUAL_CHARGE_STOP': {
        name: 'GUI_EQUAL_CHARGE_STOP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_FACTORY_TEST_FAN': {
        name: 'GUI_FACTORY_TEST_FAN',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_FACTORY_TEST_PUMP': {
        name: 'GUI_FACTORY_TEST_PUMP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_FACTORY_TEST_RELAY': {
        name: 'GUI_FACTORY_TEST_RELAY',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_FACTORY_TEST_XCOM': {
        name: 'GUI_FACTORY_TEST_XCOM',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_GRID_POW': {
        name: 'Net Power Current',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_HOUSE_POW': {
        name: 'House Power Current',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_INIT_CHARGE_START': {
        name: 'GUI_INIT_CHARGE_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_INIT_CHARGE_STOP': {
        name: 'GUI_INIT_CHARGE_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_INVERTER_POWER': {
        name: 'PV Power current',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_MAINT_CHARGE_START': {
        name: 'GUI_MAINT_CHARGE_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_MAINT_CHARGE_STOP': {
        name: 'GUI_MAINT_CHARGE_STOP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_PAUSE_SPECIAL': {
        name: 'GUI_PAUSE_SPECIAL',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_SAFETY_CHARGE': {
        name: 'Safety Charge active',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_SCHARGE_ELAPSED': {
        name: 'GUI_SCHARGE_ELAPSED',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_SCHARGE_REMAIN': {
        name: 'GUI_SCHARGE_REMAIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_SULFAT_CHARGE_START': {
        name: 'GUI_SULFAT_CHARGE_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_SULFAT_CHARGE_STOP': {
        name: 'GUI_SULFAT_CHARGE_STOP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_TEST_CHARGE_STAT': {
        name: 'GUI_TEST_CHARGE_STAT',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.GUI_TEST_DISCHARGE_STAT': {
        name: 'GUI_TEST_DISCHARGE_STAT',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_ACK': {
        name: 'INIT_CHARGE_ACK',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_DIFF_VOLTAGE': {
        name: 'INIT_CHARGE_DIFF_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_MAX_CURRENT': {
        name: 'INIT_CHARGE_MAX_CURRENT',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_MAX_VOLTAGE': {
        name: 'INIT_CHARGE_MAX_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_MIN_VOLTAGE': {
        name: 'INIT_CHARGE_MIN_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_RERUN': {
        name: 'INIT_CHARGE_RERUN',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_RUNNING': {
        name: 'INIT_CHARGE_RUNNING',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_STATE': {
        name: 'INIT_CHARGE_STATE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_TIMER': {
        name: 'INIT_CHARGE_TIMER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_CHARGE_WATER_READY': {
        name: 'INIT_CHARGE_WATER_READY',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.INIT_DISCHARGE_MAX_CURRENT': {
        name: 'INIT_DISCHARGE_MAX_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.LI_STORAGE_MODE_RUNNING': {
        name: 'LI_STORAGE_MODE_RUNNING',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.LI_STORAGE_MODE_START': {
        name: 'LI_STORAGE_MODE_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.LI_STORAGE_MODE_STOP': {
        name: 'LI_STORAGE_MODE_STOP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.MAINT_CHARGE_FINISHED': {
        name: 'MAINT_CHARGE_FINISHED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.MAINT_CHARGE_INTERVAL': {
        name: 'MAINT_CHARGE_INTERVAL',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.MAINT_CHARGE_READY': {
        name: 'MAINT_CHARGE_READY',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.MAINT_CHARGE_RUNNING': {
        name: 'MAINT_CHARGE_RUNNING',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.OFFPEAK_CURRENT': {
        name: 'Offpeak Current',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'ENERGY.OFFPEAK_DURATION': {
        name: 'Offpeak Duration',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.OFFPEAK_POWER': {
        name: 'Offpeak Power',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'ENERGY.OFFPEAK_RUNNING': {
        name: 'Offpeak Running',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'ENERGY.OFFPEAK_TARGET': {
        name: 'Offpeak Target',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.SAFE_CHARGE_FORCE': {
        name: 'Safety charge forced',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.SAFE_CHARGE_PROHIBIT': {
        name: 'Safety charge prohibited',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.SAFE_CHARGE_RUNNING': {
        name: 'Safety charge running',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_DAYS_SINCE_MAINT': {
        name: 'Days since maintenance',
        unit: 'd',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_HOURS_OF_OPERATION': {
        name: 'Hours of operation',
        unit: 'h',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_LIMITED_NO_STAND_BY': {
        name: 'LIMITED_NO_STAND_BY',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_LIMITED_NET_SKEW': {
        name: 'LIMITED_NET_SKEW',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_LIMITED_RCR': {
        name: 'STAT_LIMITED_RCR',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_MAINT_REQUIRED': {
        name: 'Maintenance required',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_SULFAT_CHRG_COUNTER': {
        name: 'SULFAT_CHRG_COUNTER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_STATE': {
        name: 'System Mode',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_STATE_DECODE': {
        name: 'System Mode decode',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.STAT_STATE_Text': {
        name: 'System Mode',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.SULFAT_CHARGE_RUN': {
        name: 'SULFAT_CHARGE_RUN',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.SUPP_BATT_DIAG': {
        name: 'SUPP_BATT_DIAG',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.TEST_CHARGE_CHRG_START': {
        name: 'TEST_CHARGE_CHRG_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.TEST_CHARGE_CHRG_STOP': {
        name: 'TEST_CHARGE_CHRG_STOP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.TEST_CHARGE_DIS_START': {
        name: 'TEST_CHARGE_DIS_START',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.TEST_CHARGE_DIS_STOP': {
        name: 'TEST_CHARGE_DIS_STOP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.TEST_CYCLE': {
        name: 'TEST_CYCLE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'ENERGY.ZERO_EXPORT': {
        name: 'ZERO_EXPORT',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.AUX_TYPE': {
        name: 'AUX_TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.BAT_TYPE': {
        name: 'BAT_TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.BAT_TYPE_Text': {
        name: 'BAT_TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.BEH_FLAGS': {
        name: 'BEH_FLAGS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.CELL_TYPE': {
        name: 'CELL_TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.COUNTRY': {
        name: 'COUNTRY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.COUNTRY_Text': {
        name: 'COUNTRY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.DEVICE_ID': {
        name: 'DEVICE_ID',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.DESIGN_CAPACITY': {
        name: 'Design capactiy',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 0.001
    },
	'FACTORY.FAC_SANITY': {
        name: 'FAC_SANITY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.MAX_CHARGE_POWER_DC': {
        name: 'maximum charge power DC',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.MAX_DISCHARGE_POWER_DC': {
        name: 'maximum discharge power DC',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.PM_TYPE': {
        name: 'PM_TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.SYS_TYPE': {
        name: 'System Type',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.SYS_TYPE_Text': {
        name: 'System Type',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FACTORY.TEMP_TYPE': {
        name: 'TEMP_TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'FEATURES.SGREADY': {
        name: 'SG Ready',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.SOCKETS': {
        name: 'Sockets',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.SHKW': {
        name: 'SHKW',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.PEAKSHAVING': {
        name: 'Peakshaving',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.ISLAND': {
        name: 'Island',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.ISLAND_PRO': {
        name: 'ISLAND_PRO',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.HEAT': {
        name: 'Heat',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.ECOGRIDREADY': {
        name: 'Econamic Grid Ready',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.CLOUDREADY': {
        name: 'Cloud Ready',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'FEATURES.CAR': {
        name: 'Car',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VVAR_PERCENT': {
        name: 'GRIDCONFIG.AU2020_VVAR_PERCENT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VVAR_PMAX': {
        name: 'GRIDCONFIG.AU2020_VVAR_PMAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VVAR_PMIN': {
        name: 'GRIDCONFIG.AU2020_VVAR_PMIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VVAR_VMAX': {
        name: 'GRIDCONFIG.AU2020_VVAR_VMAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VVAR_VMIN': {
        name: 'GRIDCONFIG.AU2020_VVAR_VMIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VVAR_VOLTAGE': {
        name: 'GRIDCONFIG.AU2020_VVAR_VOLTAGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWC_PERCENT': {
        name: 'GRIDCONFIG.AU2020_VWC_PERCENT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWC_PMAX': {
        name: 'GRIDCONFIG.AU2020_VWC_PMAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWC_PMIN': {
        name: 'GRIDCONFIG.AU2020_VWC_PMIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWC_VMAX': {
        name: 'GRIDCONFIG.AU2020_VWC_VMAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWC_VMIN': {
        name: 'GRIDCONFIG.AU2020_VWC_VMIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWC_VOLTAGE': {
        name: 'GRIDCONFIG.AU2020_VWC_VOLTAGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWD_PERCENT': {
        name: 'GRIDCONFIG.AU2020_VWD_PERCENT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWD_PMAX': {
        name: 'GRIDCONFIG.AU2020_VWD_PMAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWD_PMIN': {
        name: 'GRIDCONFIG.AU2020_VWD_PMIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWD_VMAX': {
        name: 'GRIDCONFIG.AU2020_VWD_VMAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWD_VMIN': {
        name: 'GRIDCONFIG.AU2020_VWD_VMIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_VWD_VOLTAGE': {
        name: 'GRIDCONFIG.AU2020_VWD_VOLTAGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_WGRA': {
        name: 'GRIDCONFIG.AU2020_WGRA',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_WGRA_MIN': {
        name: 'GRIDCONFIG.AU2020_WGRA_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU2020_WGRA_MAX': {
        name: 'GRIDCONFIG.AU2020_WGRA_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_FIXED_FAC': {
        name: 'AU_FIXED_FAC',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_GRID_CODE': {
        name: 'AU_GRID_CODE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_P_RAMP_CH': {
        name: 'AU_P_RAMP_CH',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_P_RAMP_DI': {
        name: 'AU_P_RAMP_DI',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_RESP_MODE': {
        name: 'AU_RESP_MODE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_SOFT_RAMP_EN': {
        name: 'AU_SOFT_RAMP_EN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_TARGET_TY': {
        name: 'AU_TARGET_TY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_VRR_MAX': {
        name: 'AU_VRR_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_VRR_MIN': {
        name: 'AU_VRR_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_VVAR_PERCENTAGE': {
        name: 'AU_VVAR_PERCENTAGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_VVAR_P_MAX': {
        name: 'AU_VVAR_P_MAX',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_VVAR_P_MIN': {
        name: 'AU_VVAR_P_MIN',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_VVAR_VOLTAGE': {
        name: 'AU_VVAR_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_VWC_VOLTAGE': {
        name: 'AU_VWC_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.AU_VWD_VOLTAGE': {
        name: 'AU_VWD_VOLTAGE',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_COS_PHI': {
        name: 'CEI_COS_PHI',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_COS_PHI_ENABLE': {
        name: 'CEI_COS_PHI_ENABLE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_CPHI_LOIN': {
        name: 'CEI_CPHI_LOIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_CPHI_LOUT': {
        name: 'CEI_CPHI_LOUT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_FREQ_MAX': {
        name: 'CEI_FREQ_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_FREQ_MIN': {
        name: 'CEI_FREQ_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_REC_TIME': {
        name: 'CEI_REC_TIME',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_RED_DROP': {
        name: 'CEI_RED_DROP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_SEGNALE_ESTERNO': {
        name: 'CEI_SEGNALE_ESTERNO',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_STAB_AC_DE': {
        name: 'CEI_STAB_AC_DE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_STAB_LO_CO': {
        name: 'CEI_STAB_LO_CO',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_STAB_LO_TH': {
        name: 'CEI_STAB_LO_TH',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_STAB_UP_CO': {
        name: 'CEI_STAB_UP_CO',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_STAB_UP_TH': {
        name: 'CEI_STAB_UP_TH',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.CEI_STAB_VOL_TH': {
        name: 'CEI_STAB_VOL_TH',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.PWRCFG_COS_POINT1': {
        name: 'PWRCFG_COS_POINT1',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.PWRCFG_COS_POINT3': {
        name: 'PWRCFG_COS_POINT3',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.PWRCFG_COS_POINT_2A': {
        name: 'PWRCFG_COS_POINT_2A',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.PWRCFG_COS_POINT_2B': {
        name: 'PWRCFG_COS_POINT_2B',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.PWRCFG_USE_COS_PHI_CURVE': {
        name: 'PWRCFG_USE_COS_PHI_CURVE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.PWRCFG_USE_MAX_PWR_SKEW': {
        name: 'PWRCFG_USE_MAX_PWR_SKEW',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDECOSPHITIME': {
        name: 'VDECOSPHITIME',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDEFIXEDFAC': {
        name: 'VDEFIXEDFAC',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_FREQDROPPROT': {
        name: 'VDE_FREQDROPPROT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_FREQDROPPROTDELAY': {
        name: 'VDE_FREQDROPPROTDELAY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_FREQRISEPROT': {
        name: 'VDE_FREQRISEPROT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_FREQRISEPROTDELAY': {
        name: 'VDE_FREQRISEPROTDELAY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_UNDERFREQLIMIT': {
        name: 'VDE_UNDERFREQLIMIT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTDROPPROT': {
        name: 'VDE_VOLTDROPPROT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTDROPPROTAVG': {
        name: 'VDE_VOLTDROPPROTAVG',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTDROPPROTAVG': {
        name: 'VDE_VOLTDROPPROTAVG',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTDROPPROTAVGDELAY': {
        name: 'VDE_VOLTDROPPROTAVGDELAY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTDROPPROTDELAY': {
        name: 'VDE_VOLTDROPPROTDELAY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTRISEPROT': {
        name: 'VDE_VOLTRISEPROT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTRISEPROTAVG': {
        name: 'VDE_VOLTRISEPROTAVG',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTRISEPROTAVGDELAY': {
        name: 'VDE_VOLTRISEPROTAVGDELAY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDE_VOLTRISEPROTDELAY': {
        name: 'VDE_VOLTRISEPROTDELAY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDEOVERFREQDROOP': {
        name: 'VDEOVERFREQDROOP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDEOVERFREQLIMIT': {
        name: 'VDEOVERFREQLIMIT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDERECOVERTIME': {
        name: 'VDERECOVERTIME',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDETARGETTY': {
        name: 'VDETARGETTY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDEURMSMAX10': {
        name: 'VDEURMSMAX10',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'GRIDCONFIG.VDEUNDERFREQDROOP': {
        name: 'VDEUNDERFREQDROOP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'LOG.LOG_IN_BUTT': {
        name: 'Log In Button',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'LOG.LOG_OUT_BUTT': {
        name: 'Log Out Button',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'LOG.PASSWORD': {
        name: 'Password',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'LOG.USER_LEVEL': {
        name: 'User Level',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'LOG.USERNAME': {
        name: 'User Name',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PM1.MB_SL2MA_CONN': {
        name: 'PM1.MB_SL2MA_CONN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PM1.MB_SLAVES_COUNT': {
        name: 'PM1.MB_SLAVES_COUNT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PM1.PWR_METERS_MISSING': {
        name: 'PM1.PWR_METERS_MISSING',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PM1.TYPE': {
        name: 'PM1.TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PM1OBJ1.ADR': {
        name: 'PM1OBJ1.ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ1.FREQ': {
        name: 'EnFluRi-Netz.FREQ',
        unit: 'Hz',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ1.U_AC': {
        name: 'EnFluRi-Netz.U_AC',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ1.I_AC': {
        name: 'EnFluRi-Netz.I_AC',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ1.P_AC': {
        name: 'EnFluRi-Netz.P_AC',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ1.ENABLED': {
        name: 'EnFluRi-Netz.Aktiv',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ1.P_TOTAL': {
        name: 'EnFluRi-Netz.P_TOTAL',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PM1OBJ2.ADR': {
        name: 'PM1OBJ2.ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ2.FREQ': {
        name: 'EnFluRi-Verbrauch.FREQ',
        unit: 'Hz',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ2.U_AC': {
        name: 'EnFluRi-Verbrauch.U_AC',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ2.I_AC': {
        name: 'EnFluRi-Verbrauch.I_AC',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ2.P_AC': {
        name: 'EnFluRi-Verbrauch.P_AC',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ2.ENABLED': {
        name: 'EnFluRi-Verbrauch.Aktiv',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PM1OBJ2.P_TOTAL': {
        name: 'EnFluRi-Verbrauch.P_TOTAL',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.ERROR_STATE_INT': {
        name: 'ERROR_STATE_INT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.MPP_CUR': {
        name: 'Energy DC',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.MPP_INT': {
        name: 'Replaced by MPP_POWER',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_INV_ERROR_TEXT': {
		name: 'Internal inverter error text',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_INV_ERR_STATE_VALID': {
		name: 'Internal inverter error state valid',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_INV_STATE': {
		name: 'Internal inverter state',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_MD_AVAIL': {
		name: 'Internal MD available',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_MD_MANUFACTURER': {
		name: 'Internal MD manufacturer',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_MD_MODEL': {
		name: 'Internal MD model',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_MD_SERIAL': {
		name: 'Internal MD serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_MD_VERSION': {
		name: 'Internal MD version',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INTERNAL_PV_AVAIL': {
		name: 'Internal PV available',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INV_MODEL': {
		name: 'Inverter model',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INV_SERIAL': {
		name: 'Inverter serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.INV_VERSIONS': {
		name: 'Inverter versions',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.MPP_AVAIL': {
		name: 'MPP available',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.MPP_VOL': {
        name: 'Voltage DC',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.MPP_POWER': {
        name: 'Power DC',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.POWER_RATIO': {
        name: 'PV1 Power Ratio',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.POWER_RATIO_L1': {
        name: 'PV1 Power Ratio L1',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.POWER_RATIO_L2': {
        name: 'PV1 Power Ratio L2',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'PV1.POWER_RATIO_L3': {
        name: 'PV1 Power Ratio L3',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.PV_MISSING': {
        name: 'PV_MISSING',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.P_TOTAL': {
        name: 'Power Total',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.STATE_INT': {
        name: 'STATE_INT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.TYPE': {
        name: 'TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.ADRESS': {
        name: 'ADRESS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.CONNPWR': {
        name: 'CONNPWR',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.CONNPWR_1': {
        name: 'CONNPWR_1',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.CONNPWR_2': {
        name: 'CONNPWR_2',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.CONNPWR_3': {
        name: 'CONNPWR_3',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.CURRENTTEMP_MAX': {
        name: 'CURRENTTEMP_MAX',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.CURRENTTEMP_MAX_HW': {
        name: 'CURRENTTEMP_MAX_HW',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.CURRENTTEMP_MIN': {
        name: 'CURRENTTEMP_MIN',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.CURRENTTEMP_MIN_HW': {
        name: 'CURRENTTEMP_MIN_HW',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.ENFLURI': {
        name: 'ENFLURI',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.FW_VER': {
        name: 'FW_VER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.HW_REV': {
        name: 'HW_REV',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.POWER': {
        name: 'POWER',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.POWER_L1': {
        name: 'PWR_UNIT.POWER_L1',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.POWER_L2': {
        name: 'PWR_UNIT.POWER_L2',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.POWER_L3': {
        name: 'PWR_UNIT.POWER_L3',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.PU_MISSING': {
        name: 'PU_MISSING',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.REQ_POWER': {
        name: 'REQ_POWER',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.SERIAL': {
        name: 'SERIAL',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.STATUS': {
        name: 'STATUS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.TEMPMAX': {
        name: 'TEMPMAX',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.TEMPMIN': {
        name: 'TEMPMIN',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.TEMPTARGET': {
        name: 'TEMPTARGET',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.TEMP_COUNT': {
        name: 'TEMP_COUNT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.TEMP_LIMIT_LOWER': {
        name: 'TEMP_LIMIT_LOWER',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.TEMP_LIMIT_UPPER': {
        name: 'TEMP_LIMIT_UPPER',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.TYPE': {
        name: 'TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PWR_UNIT.WATERVOL': {
        name: 'WATERVOL',
        unit: 'l',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.VERSION1_INT': {
        name: 'VERSION1_INT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'PV1.VERSION2_INT': {
        name: 'VERSION2_INT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'RTC.TIMESTAMP_MS': {
        name: 'RTC.TIMESTAMP_MS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'RTC.UTC_OFFSET': {
        name: 'RTC.UTC_OFFSET',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'RTC.WEB_TIME': {
        name: 'RTC.WEB_TIME',
        unit: '',
        booltype: false,
        datetype: true,
        iptype: false,
        multiply: 1
    },
    'SOCKETS.ALREADY_SWITCHED': {
        name: 'SOCKETS.ALREADY_SWITCHED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SOCKETS.ENABLE': {
        name: 'SOCKETS.ENABLE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SOCKETS.FORCE_ON': {
        name: 'SOCKETS.FORCE_ON',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.LOWER_LIMIT': {
        name: 'SOCKETS.LOWER_LIMIT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.NUMBER_OF_SOCKETS': {
        name: 'SOCKETS.NUMBER_OF_SOCKETS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SOCKETS.POWER_ON': {
        name: 'SOCKETS.POWER_ON',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SOCKETS.POWER_ON_TIME': {
        name: 'SOCKETS.POWER_ON_TIME',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.PRIORITY': {
        name: 'SOCKETS.PRIORITY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.RESET_SWITCHED': {
        name: 'SOCKETS.RESET_SWITCHED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.SWITCH_ON_HOUR': {
        name: 'SOCKETS.SWITCH_ON_HOUR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.SWITCH_ON_MINUTE': {
        name: 'SOCKETS.SWITCH_ON_MINUTE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.TIME_LIMIT': {
        name: 'SOCKETS.TIME_LIMIT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.TIME_REM': {
        name: 'SOCKETS.TIME_REM',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.UPPER_LIMIT': {
        name: 'SOCKETS.UPPER_LIMIT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'SOCKETS.USE_TIME': {
        name: 'SOCKETS.USE_TIME',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.CURRENT_STATE': {
        name: 'Current state',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_BAT_CHARGE': {
        name: 'Battery charged',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_BAT_CHARGE_MASTER': {
        name: 'Battery charged master',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_BAT_DISCHARGE': {
        name: 'Battery discharged',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_BAT_DISCHARGE_MASTER': {
        name: 'Battery discharged master',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_GRID_EXPORT': {
        name: 'Export to Grid',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_GRID_IMPORT': {
        name: 'Import from Grid',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_HOUSE_CONS': {
        name: 'House consumption',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_PV_GEN': {
        name: 'PV Generation',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_PU_ENERGY': {
        name: 'Live PowerUnit Energy',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STATISTIC.LIVE_PV_GEN_MASTER': {
        name: 'Live PV Generation Master',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.LIVE_WB_ENERGY': {
        name: 'Live Wallbox Energy',
        unit: 'Wh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.MEASURE_TIME': {
        name: 'PV MEASURE_TIME',
        unit: '',
        booltype: false,
        datetype: true,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_BAT_CHARGE': {
        name: 'Battery charged',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_BAT_CHARGE_MASTER': {
        name: 'Battery charged Master',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_BAT_DISCHARGE': {
        name: 'Battery discharged',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_BAT_DISCHARGE_MASTER': {
        name: 'Battery discharged Master',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_DATA_PUBLISHED': {
        name: 'Data published',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_DAY_E_PV': {
        name: 'PV Power Day',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_DAY_E_GRID_IMPORT': {
        name: 'Net Import Day',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_DAY_E_GRID_EXPORT': {
        name: 'Net Export Day',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_DAY_BAT_CHARGE': {
        name: 'Accu Charged Day',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_DAY_BAT_DISCHARGE': {
        name: 'Accu Discharged Day',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_DAY_E_HOUSE': {
        name: 'House Power Day',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_GRID_EXPORT': {
        name: 'Exported to Grid total',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_GRID_IMPORT': {
        name: 'Imported from Grid total',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_HOUSE_CONSUMPTION': {
        name: 'House consumption total',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_PV_GENERATION': {
        name: 'PV generation total',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_REQ_CLEAR_REM_DATA': {
        name: 'STAT_REQ_CLEAR_REM_DATA',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_SUM_E_PU': {
        name: 'STAT_SUM Energy PowerUnit',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_SUM_E_WB': {
        name: 'STAT_SUM Energy Wallbox',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_BAT_CHR_ARR': {
        name: 'STAT_YEAR_E_BAT_CHR_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_BAT_DIS_ARR': {
        name: 'STAT_YEAR_E_BAT_DIS_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_GRID_EXP_ARR': {
        name: 'STAT_YEAR_E_GRID_EXP_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_GRID_IMP_ARR': {
        name: 'STAT_YEAR_E_GRID_IMP_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_HOUSE_ARR': {
        name: 'STAT_YEAR_E_HOUSE_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_PU0_ARR': {
        name: 'STAT_YEAR_E_PU0_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_PU1_ARR': {
        name: 'STAT_YEAR_E_PU1_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_PU2_ARR': {
        name: 'STAT_YEAR_E_PU2_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_PU3_ARR': {
        name: 'STAT_YEAR_E_PU3_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_PU4_ARR': {
        name: 'STAT_YEAR_E_PU4_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_PU5_ARR': {
        name: 'STAT_YEAR_E_PU5_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_PV_ARR': {
        name: 'STAT_YEAR_E_PV_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_WB0_ARR': {
        name: 'STAT_YEAR_E_WB0_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_WB1_ARR': {
        name: 'STAT_YEAR_E_WB1_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_WB2_ARR': {
        name: 'STAT_YEAR_E_WB2_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_E_WB3_ARR': {
        name: 'STAT_YEAR_E_WB3_ARR',
        unit: 'kWh',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.STAT_YEAR_START': {
        name: 'Starting year',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'STATISTIC.UPLOAD_B64': {
        name: 'UPLOAD_B64',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.BAT': {
		name: 'Bat',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.BDC_STATE': {
		name: 'BDC State',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.ERROR': {
		name: 'Error',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.ERRORTEXT': {
		name: 'Error text',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.ISLAND': {
		name: 'Island',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.NUM_PV_CONFIG_POSSIBLE': {
		name: '# PV config possible',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.PV': {
		name: 'PV',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.PVSS': {
		name: 'PVSS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.PV_CONFIG_POSSIBLE': {
		name: 'PV config possible',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.PV_INPUTS': {
		name: 'PV Inputs',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.RELAYS': {
		name: 'RELAYS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.STARTUP': {
		name: 'STARTUP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'STECA.STARTUP_ADD': {
		name: 'Startup add',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.BOOTLOADER_VERSION': {
        name: 'Bootloader Version',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.BOOT_REPORT_SUCCESS': {
        name: 'Boot Report Success',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.FEATURE_OVERWRITE': {
        name: 'Feature Overwrite',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.FSM_STATE': {
        name: 'FSM State',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.MISC': {
        name: 'MISC',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.NO_SERVER_CONN_TIME': {
        name: 'No Server Connection Time',
        unit: '',
        booltype: false,
        datetype: true,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.NPU_IMAGE_VERSION': {
        name: 'Revision NPU - Image',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.NPU_VER': {
        name: 'Revision NPU - REGS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.TRIGGER_BL_UPDATE': {
        name: 'Triggered BL update',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.UPDATE_AVAILABLE': {
        name: 'Update available',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.USER_REBOOT_DEVICE': {
        name: 'User Reboot Device',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.USER_REQ_INV_UPDATE': {
        name: 'User Requested INV Update',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.USER_REQ_NA_UPDATE': {
        name: 'User Requested NA Update',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'SYS_UPDATE.USER_REQ_UPDATE': {
        name: 'User Requested Update',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'TEMPMEASURE.BATTERY_TEMP': {
        name: 'TEMPMEASURE.BATTERY_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'TEMPMEASURE.CASE_TEMP': {
        name: 'TEMPMEASURE.CASE_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'TEMPMEASURE.MCU_TEMP': {
        name: 'TEMPMEASURE.MCU_TEMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'TEMPMEASURE.TEMP_DATA_COLLECTED': {
        name: 'TEMPMEASURE.MCU_TEMP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.ADDITIONAL_ERROR': {
        name: 'WALLBOX.ADDITIONAL_ERROR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.APPARENT_CHARGING_POWER': {
        name: 'WALLBOX.APPARENT_CHARGING_POWER',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.ALLOW_INTERCHARGE': {
        name: 'ALLOW_INTERCHARGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.BUS_ADR': {
        name: 'Bus ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.CS_ENABLED': {
        name: 'WALLBOX.CS_ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.DETECTION_MODE': {
        name: 'Detection Mode',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.EV_CONNECTED': {
        name: 'WALLBOX.EV_CONNECTED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.HW_TYPE': {
        name: 'WALLBOX.HW_TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.ID': {
        name: 'WALLBOX.ID',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.L1_CHARGING_CURRENT': {
        name: 'WALLBOX.L1_CHARGING_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.L2_CHARGING_CURRENT': {
        name: 'WALLBOX.L2_CHARGING_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.L3_CHARGING_CURRENT': {
        name: 'WALLBOX.L3_CHARGING_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.L1_USED': {
        name: 'WALLBOX.L1_USED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.L2_USED': {
        name: 'WALLBOX.L3_USED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.L3_USED': {
        name: 'WALLBOX.L3_USED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.LOAD_IMBALANCE_ENABLED': {
        name: 'Load imbalance enabled',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.LOAD_IMBALANCE_DETECTED': {
        name: 'Load imbalance detected',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.MAJOR_REV': {
        name: 'WALLBOX.MAJOR_REV',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.MAX_CHARGING_CURRENT_DEFAULT': {
        name: 'WALLBOX.MAX_CHARGING_CURRENT_DEFAULT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.MAX_CHARGING_CURRENT_IC': {
        name: 'WALLBOX.MAX_CHARGING_CURRENT_IC',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.MAX_CHARGING_CURRENT_ICMAX': {
        name: 'WALLBOX.MAX_CHARGING_CURRENT_ICMAX',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.MAX_CHARGING_CURRENT_RATED': {
        name: 'WALLBOX.MAX_CHARGING_CURRENT_RATED',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.MAX_PHASE_CURRENT_BY_GRID': {
        name: 'MAX_PHASE_CURRENT_BY_GRID',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.MAX_TOTAL_CURRENT_BY_GRID': {
        name: 'MAX_TOTAL_CURRENT_BY_GRID',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.METER_ENABLED': {
        name: 'WALLBOX.METER_ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.METHOD_EN1': {
        name: 'WALLBOX.METHOD_EN1',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.MIN_CHARGING_CURRENT': {
        name: 'MIN_CHARGING_CURRENT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.MINOR_REV': {
        name: 'WALLBOX.MINOR_REV',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.PHASES_USED': {
        name: 'WALLBOX.PHASES_USED',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.PROHIBIT_USAGE': {
        name: 'Prohibit usage',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.SAP_NUMBER': {
        name: 'SAP number',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.SERIAL_NUMBER': {
        name: 'Serial number',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.SERIAL_NUMBER_INTERNAL': {
        name: 'Serial number internal',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.SET_IDEFAULT': {
        name: 'SET_IDEFAULT',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.SET_ICMAX': {
        name: 'SET_ICMAX',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.SMART_CHARGE_ACTIVE': {
        name: 'Smart charge active',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WALLBOX.SOCKET_ENABLED': {
        name: 'WALLBOX.SOCKET_ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.STATE': {
        name: 'Wallbox Status',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.STATE_Text': {
        name: 'Wallbox Status',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.UID': {
        name: 'UID',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WALLBOX.UTMP': {
        name: 'WALLBOX.UTMP',
        unit: '°C',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.APPLICATION_HASH': {
        name: 'Application Hash',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.APPLICATION_VERSION': {
        name: 'Revision MCU',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.BOOT': {
        name: 'BOOT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.CHARGE_PRIO': {
        name: 'Charge Priority',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.CONFIG_CHECKSUM': {
        name: 'Configuration Checksum',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.CONFIG_LOADED': {
        name: 'Configuration loaded',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.CONFIG_MODIFIED_BY_USER': {
        name: 'Configuration modified by user',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.CONFIG_WRITE': {
        name: 'Config write',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_BATTERY_ENABLED': {
        name: 'Device Battery enabled',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_BATTERY_TYPE': {
        name: 'Device Battery Type',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_INVERTER_TYPE': {
        name: 'Device Inverter Type',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_INV_ENABLED': {
        name: 'Device Inverter Enabled',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_INV_PHASES_ARR': {
        name: 'Device Inverter Phases',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_INV_SLAVE_ADRESS': {
        name: 'Device Inverter Slave Adress',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_PM_GRID_ENABLED': {
        name: 'Device PM Grid Enabled',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_PM_HOUSE_ENABLED': {
        name: 'Device PM House enabled',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.DEVICE_PM_TYPE': {
        name: 'Device PM Type',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.DEVICE_WB_TYPE': {
        name: 'Device WB Type',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.FEATURECODE_ENTERED': {
        name: 'Featurecode entered',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.FIRMWARE_VERSION': {
        name: 'Firmware Version',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.GENERATION_METER_SN': {
        name: 'Generation Meter Serialnumber',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.GRID_CONNECTION_TYPE': {
        name: 'Grid Connection Type',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.GUI_LANG': {
        name: 'GUI Language',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.HEATPUMP_METER_SN': {
        name: 'HEATPUMP_METER_SN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.HEAT_CONN_TYPE': {
        name: 'HEAT_CONN_TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.INSULATION_RESISTANCE': {
        name: 'INSULATION_RESISTANCE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.INTERFACE_VERSION': {
        name: 'Revision GUI',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.MAC_ADDRESS_BYTES': {
        name: 'MAC Address Bytes',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.MASTER_SLAVE_ADDRESSES': {
        name: 'Master Slave Addresses',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.MASTER_SLAVE_MODE': {
        name: 'Master Slave Mode',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.NET_DNS_SERVER_IP': {
        name: 'NET_DNS_SERVER_IP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.NET_GATEWAY_IP': {
        name: 'NET_GATEWAY_IP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.NET_NETWORK_MASK': {
        name: 'NET_NETWORK_MASK',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.NET_SENEC_NO_NETWORK': {
        name: 'NET_SENEC_NO_NETWORK',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.NET_SENEC_SERVER_IP': {
        name: 'NET_SENEC_SERVER_IP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.NET_SENEC_STATIC_IP': {
        name: 'NET_SENEC_STATIC_IP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.NET_SENEC_USE_DHCP': {
        name: 'NET_SENEC_USE_DHCP',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.POWER_METER_SERIAL': {
        name: 'Power Meter Serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.PS_ENABLE': {
        name: 'PeakShaving ENABLE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.PS_HOUR': {
        name: 'PeakShaving hour',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.PS_MINUTE': {
        name: 'PeakShaving Minute',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.PS_RESERVOIR': {
        name: 'PeakShaving Reservoir',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.PV_CONFIG': {
        name: 'PV_CONFIG',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.PWRCFG_PEAK_PV_POWER': {
        name: 'Configured Peak PV Power',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SENEC_METER_SN': {
        name: 'SENEC_METER_SN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_ABS_POWER': {
        name: 'SETUP_ABS_POWER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_AGBS_ACCEPTED': {
        name: 'SETUP_AGBS_ACCEPTED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.SETUP_HV_PHASE': {
        name: 'SETUP_HV_PHASE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_NUMBER_WALLBOXES': {
        name: '# Wallboxes',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_PM_GRID_ADR': {
        name: 'SETUP_PM_GRID_ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_PM_HOUSE_ADR': {
        name: 'SETUP_PM_HOUSE_ADR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_POWER_RULE': {
        name: 'SETUP_POWER_RULE',
        unit: '%',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_PV_INV_IP0': {
        name: 'SETUP_PV_INV_IP0',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.SETUP_PV_INV_IP1': {
        name: 'SETUP_PV_INV_IP1',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.SETUP_PV_INV_IP2': {
        name: 'SETUP_PV_INV_IP2',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.SETUP_PV_INV_IP3': {
        name: 'SETUP_PV_INV_IP3',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.SETUP_PV_INV_IP4': {
        name: 'SETUP_PV_INV_IP4',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.SETUP_PV_INV_IP5': {
        name: 'SETUP_PV_INV_IP5',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: true
    },
    'WIZARD.SETUP_RCR_STEPS': {
        name: 'Setup RCR Steps',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.SETUP_USE_DRM0': {
        name: 'SETUP_USE_DRM0',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_USED_PHASE': {
        name: 'SETUP_USED_PHASE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_USE_ABS_POWER': {
        name: 'SETUP_USE_ABS_POWER',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_USE_RCR': {
        name: 'SETUP_USE_RCR',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.SETUP_WALLBOX_MAX_TOTAL_CURRENT_BY_GRID': {
        name: 'SETUP_WALLBOX_MAX_TOTAL_CURRENT_BY_GRID',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.SG_READY_CURR_MODE': {
        name: 'SG_READY_CURR_MODE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.SG_READY_ENABLE_OVERWRITE': {
        name: 'SG_READY_ENABLE_OVERWRITE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.SG_READY_OVERWRITE_RELAY': {
        name: 'SG_READY_OVERWRITE_RELAY',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.TEST_EG_METER': {
        name: 'TEST_EG_METER',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.TEST_GENERATION_METER': {
        name: 'TEST_GENERATION_METER',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.TEST_HEATPUMP_METER': {
        name: 'TEST_HEATPUMP_METER',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.TEST_SENEC_METER': {
        name: 'TEST_SENEC_METER',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.USE_TESTSERVER': {
        name: 'USE_TESTSERVER',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_WALLBOX_SERIAL0': {
        name: 'Wallbox 0 Serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_WALLBOX_IDS': {
        name: 'Setup Wallbox IDs',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_WALLBOX_SERIAL1': {
        name: 'Wallbox 1 Serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_WALLBOX_SERIAL2': {
        name: 'Wallbox 2 Serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SETUP_WALLBOX_SERIAL3': {
        name: 'Wallbox 3 Serial',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SG_READY_ENABLED': {
        name: 'SG_READY_ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SG_READY_EN_MODE1': {
        name: 'SG_READY_EN_MODE1',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SG_READY_POWER_COMM': {
        name: 'SG_READY_POWER_COMM',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SG_READY_POWER_PROP': {
        name: 'SG_READY_POWER_PROP',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
    'WIZARD.SG_READY_TIME': {
        name: 'SG_READY_TIME',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
	'WIZARD.ZEROMODULE': {
        name: 'ZEROMODULE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },'GRIDCONFIG.AU2020_VNOMMAX_RANGE': {
        name: 'AU2020_VNOMMAX_RANGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_VNOMMAX_MIN': {
        name: 'AU2020_VNOMMAX_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_VNOMMAX_MAX': {
        name: 'AU2020_VNOMMAX_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_SELECTED_REGION': {
        name: 'AU2020_SELECTED_REGION',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_RESPONSE_MODES': {
        name: 'AU2020_RESPONSE_MODES',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_REACTIVEPOWER_MIN': {
        name: 'AU2020_REACTIVEPOWER_MIN',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_REACTIVEPOWER_MAX': {
        name: 'AU2020_REACTIVEPOWER_MAX',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_REACTIVEPOWER': {
        name: 'AU2020_REACTIVEPOWER',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_NOT_DEFAULT': {
        name: 'AU2020_NOT_DEFAULT',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_HEXPORT_ENABLED': {
        name: 'AU2020_HEXPORT_ENABLED',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_HEXPORT': {
        name: 'AU2020_HEXPORT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FULCO_MIN': {
        name: 'AU2020_FULCO_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FULCO_MAX': {
        name: 'AU2020_FULCO_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FULCO': {
        name: 'AU2020_FULCO',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FTRANSITION_MIN': {
        name: 'AU2020_FTRANSITION_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FTRANSITION_MAX': {
        name: 'AU2020_FTRANSITION_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FTRANSITION': {
        name: 'AU2020_FTRANSITION',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FSTOPCH_MIN': {
        name: 'AU2020_FSTOPCH_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FSTOPCH_MAX': {
        name: 'AU2020_FSTOPCH_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FSTOPCH': {
        name: 'AU2020_FSTOPCH',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FPMIN_MIN': {
        name: 'AU2020_FPMIN_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FPMIN_MAX': {
        name: 'AU2020_FPMIN_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FPMIN': {
        name: 'AU2020_FPMIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FPMAX_MIN': {
        name: 'AU2020_FPMAX_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FPMAX_MAX': {
        name: 'AU2020_FPMAX_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FPMAX': {
        name: 'AU2020_FPMAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FLLCO_MIN': {
        name: 'AU2020_FLLCO_MIN',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FLLCO_MAX': {
        name: 'AU2020_FLLCO_MAX',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FLLCO': {
        name: 'AU2020_FLLCO',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_FIXEDFACTOR': {
        name: 'AU2020_FIXEDFACTOR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_COSPHIMODE': {
        name: 'AU2020_COSPHIMODE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.AU2020_ACTIVE_REGISTER': {
        name: 'AU2020_ACTIVE_REGISTER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'WIZARD.LOGGER_SEVERITY': {
        name: 'LOGGER_SEVERITY',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'WIZARD.BATT_IPU_MISMATCH': {
        name: 'BATT_IPU_MISMATCH',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_TARGET_POWER': {
        name: 'VPP_TARGET_POWER',
        unit: 'W',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_STARTTIME_MINUTE': {
        name: 'VPP_STARTTIME_MINUTE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_STARTTIME_HOUR': {
        name: 'VPP_STARTTIME_HOUR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_LAST_CHANGE_UTC': {
        name: 'VPP_LAST_CHANGE_UTC',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_IS_ACTIVE': {
        name: 'VPP_IS_ACTIVE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_IGNORE_COUNTRY_TYPE': {
        name: 'VPP_IGNORE_COUNTRY_TYPE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_EXPORT_LIMIT': {
        name: 'VPP_EXPORT_LIMIT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_ENDTIME_MINUTE': {
        name: 'VPP_ENDTIME_MINUTE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_ENDTIME_HOUR': {
        name: 'VPP_ENDTIME_HOUR',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_DAILY_PARAMETER_RESET': {
        name: 'VPP_DAILY_PARAMETER_RESET',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_ACTIVATE_TARGET_POWER': {
        name: 'VPP_ACTIVATE_TARGET_POWER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'ENERGY.VPP_ACTIVATE_EXPORT_LIMIT': {
        name: 'VPP_ACTIVATE_EXPORT_LIMIT',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'TEST.TYPE': {
		name: 'TYPE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'TEST.START': {
		name: 'START',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'TEST.RESULT': {
		name: 'RESULT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'TEST.OUTPUT': {
		name: 'OUTPUT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'TEST.INPUT': {
		name: 'INPUT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'TEST.ENABLE': {
		name: 'ENABLE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'DISPLAY.CURRENT_MESSAGE_PRIO': {
		name: 'CURRENT_MESSAGE_PRIO',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'DISPLAY.CURRENT_MESSAGE_OWNER': {
		name: 'CURRENT_MESSAGE_OWNER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'DISPLAY.CURRENT_MESSAGE': {
		name: 'CURRENT_MESSAGE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'FAN_TEST.INV_LV': {
		name: 'INV_LV',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'FAN_TEST.INV_HV': {
		name: 'INV_HV',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'FAN_SPEED.INV_LV': {
		name: 'INV_LV',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'FAN_SPEED.INV_HV': {
		name: 'INV_HV',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'WIZARD.SG_READY_POWER_NORMAL': {
		name: 'SG_READY_POWER_NORMAL',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'WALLBOX.NUMBER_OF_PHASE': {
		name: 'NUMBER_OF_PHASE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'WALLBOX.ERROR_DETAILS': {
		name: 'ERROR_DETAILS',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'LOG.LOG_IN_NOK_COUNT': {
		name: 'LOG_IN_NOK_COUNT',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'GRIDCONFIG.VDEPT1RESPONSETIME': {
		name: 'VDEPT1RESPONSETIME',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'FACTORY.EPA_GRID_FILTER': {
		name: 'EPA_GRID_FILTER',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'BMS_PARA.OPERATIONAL_MODE': {
		name: 'OPERATIONAL_MODE',
        unit: '',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'BMS_PARA.MAX_MODULE_DISCHARGE_CURRENT_LIMIT_A': {
		name: 'MAX_MODULE_DISCHARGE_CURRENT_LIMIT_A',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'BMS_PARA.MAX_MODULE_CHARGE_CURRENT_LIMIT_A': {
		name: 'MAX_MODULE_CHARGE_CURRENT_LIMIT_A',
        unit: 'A',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'BMS_PARA.FULL_CELL_VOLTAGE_MV': {
		name: 'FULL_CELL_VOLTAGE_MV',
        unit: 'V',
        booltype: false,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'BMS_PARA.FORCE_OP_MODE': {
		name: 'FORCE_OP_MODE',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'BMS_PARA.FORCE_BMS_ERROR': {
		name: 'FORCE_BMS_ERROR',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },
'BMS_PARA.USE_ROA_PARAMETER': {
		name: 'USE_ROA_PARAMETER',
        unit: '',
        booltype: true,
        datetype: false,
        iptype: false,
        multiply: 1
    },

}

module.exports = state_attr;
