/**
 * Translate senec numeric battery types to the official human readable representation.
 * Please report unknown values.
 */
const batt_type_desc = {
    '0': {
        name: 'Studer Xtender (0)',
    },
    '1': {
        name: 'SenecBatt (1)',
    },
    '2': {
        name: 'Senec Inverter V2 (2)',
    },
    '3': {
        name: 'SENEC.Inverter V2.1 (3)',
    },
	'4': {
        name: 'SENEC.Inverter V3 LV (4)',
    },
}

module.exports = batt_type_desc;
