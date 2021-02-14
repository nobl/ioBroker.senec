/**
 * Translate senec numeric system state modes to the official human readable representation.
 * Please report unknown values.
 * if you can supply me with the correct (senec chargon!) values in english, please open a ticket
 */
const mode_desc = {
    '0': {
        name: 'INITIALZUSTAND (0)',
    },
    '1': {
        name: 'KEINE KOMMUNIKATION LADEGERAET (1)',
    },
    '2': {
        name: 'FEHLER LEISTUNGSMESSGERAET (2)',
    },
    '3': {
        name: 'RUNDSTEUEREMPFAENGER (3)',
    },
    '4': {
        name: 'ERSTLADUNG (4)',
    },
    '5': {
        name: 'WARTUNGSLADUNG (5)',
    },
    '6': {
        name: 'WARTUNGSLADUNG FERTIG (6)',
    },
    '7': {
        name: 'WARTUNG NOTWENDIG (7)',
    },
    '8': {
        name: 'MAN. SICHERHEITSLADUNG (8)',
    },
    '9': {
        name: 'SICHERHEITSLADUNG FERTIG (9)',
    },
    '10': {
        name: 'VOLLLADUNG (10)',
    },
    '11': {
        name: 'AUSGLEICHSLADUNG: LADEN (11)',
    },
    '12': {
        name: 'SULFATLADUNG: LADEN (12)',
    },
    '13': {
        name: 'AKKU VOLL (13)',
    },
    '14': {
        name: 'LADEN (14)',
    },
    '15': {
        name: 'AKKU LEER (15)',
    },
    '16': {
        name: 'ENTLADEN (16)',
    },
    '17': {
        name: 'PV + ENTLADEN (17)',
    },
    '18': {
        name: 'NETZ + ENTLADEN (18)',
    },
    '19': {
        name: 'PASSIV (19)',
    },
    '20': {
        name: 'AUSGESCHALTET (20)',
    },
    '21': {
        name: 'EIGENVERBRAUCH (21)',
    },
    '22': {
        name: 'NEUSTART (22)',
    },
    '23': {
        name: 'MAN. AUSGLEICHSLADUNG: LADEN (23)',
    },
    '24': {
        name: 'MAN. SULFATLADUNG: LADEN (24)',
    },
    '25': {
        name: 'SICHERHEITSLADUNG (25)',
    },
    '26': {
        name: 'AKKU-SCHUTZBETRIEB (26)',
    },
    '27': {
        name: 'EG FEHLER (27)',
    },
    '28': {
        name: 'EG LADEN (28)',
    },
    '29': {
        name: 'EG ENTLADEN (29)',
    },
    '30': {
        name: 'EG PASSIV (30)',
    },
    '31': {
        name: 'EG LADEN VERBOTEN (31)',
    },
    '32': {
        name: 'EG ENTLADEN VERBOTEN (32)',
    },
    '33': {
        name: 'NOTLADUNG (33)',
    },
    '34': {
        name: 'SOFTWAREAKTUALISIERUNG (34)',
    },
    '35': {
        name: 'FEHLER: NA-SCHUTZ (35)',
    },
    '36': {
        name: 'FEHLER: NA-SCHUTZ NETZ (36)',
    },
    '37': {
        name: 'FEHLER: NA-SCHUTZ HARDWARE (37)',
    },
    '38': {
        name: 'KEINE SERVERVERBINDUNG (38)',
    },
    '39': {
        name: 'BMS FEHLER (39)',
    },
    '40': {
        name: 'WARTUNG: FILTER (40)',
    },
    '41': {
        name: 'SCHLAFMODUS (41)',
    },
    '42': {
        name: 'WARTE AUF ÜBERSCHUSS (42)',
    },
    '43': {
        name: 'KAPAZITÄTSTEST: LADEN (43)',
    },
    '44': {
        name: 'KAPAZITÄTSTEST: ENTLADEN (44)',
    },
    '45': {
        name: 'MAN. SULFATLADUNG: WARTEN (45)',
    },
    '46': {
        name: 'MAN. SULFATLADUNG: FERTIG (46)',
    },
    '47': {
        name: 'MAN. SULFATLADUNG: FEHLER (47)',
    },
    '48': {
        name: 'AUSGLEICHSLADUNG: WARTEN (48)',
    },
    '49': {
        name: 'NOTLADUNG: FEHLER (49)',
    },
    '50': {
        name: 'MAN: AUSGLEICHSLADUNG: WARTEN (50)',
    },
    '51': {
        name: 'MAN: AUSGLEICHSLADUNG: FEHLER (51)',
    },
    '52': {
        name: 'MAN: AUSGLEICHSLADUNG: FERTIG (52)',
    },
    '53': {
        name: 'AUTO: SULFATLADUNG: WARTEN (53)',
    },
    '54': {
        name: 'LADESCHLUSSPHASE (54)',
    },
    '55': {
        name: 'BATTERIETRENNSCHALTER AUS (55)',
    },
    '56': {
        name: 'PEAK-SHAVING: WARTEN (56)',
    },
    '57': {
        name: 'FEHLER LADEGERAET (57)',
    },
    '58': {
        name: 'NPU-FEHLER (58)',
    },
    '59': {
        name: 'BMS OFFLINE (59)',
    },
    '60': {
        name: 'WARTUNGSLADUNG FEHLER (60)',
    },
    '61': {
        name: 'MAN. SICHERHEITSLADUNG FEHLER (61)',
    },
    '62': {
        name: 'SICHERHEITSLADUNG FEHLER (62)',
    },
    '63': {
        name: 'KEINE MASTERVERBINDUNG (63)',
    },
    '64': {
        name: 'LITHIUM SICHERHEITSMODUS AKTIV (64)',
    },
    '65': {
        name: 'LITHIUM SICHERHEITSMODUS BEENDET (65)',
    },
    '66': {
        name: 'FEHLER BATTERIESPANNUNG (66)',
    },
    '67': {
        name: 'BMS DC AUSGESCHALTET (67)',
    },
    '68': {
        name: 'NETZINITIALISIERUNG (68)',
    },
    '69': {
        name: 'NETZSTABILISIERUNG (69)',
    },
    '70': {
        name: 'FERNABSCHALTUNG (70)',
    },
    '71': {
        name: 'OFFPEAK-LADEN (71)',
    },
    '72': {
        name: 'FEHLER HALBBRÜCKE (72)',
    },
    '73': {
        name: 'BMS: FEHLER BETRIEBSTEMPERATUR (73)',
    },
    '74': {
        name: 'FACOTRY SETTINGS NICHT GEFUNDEN (74)',
    },
    '75': {
        name: 'NETZERSATZBETRIEB (75)',
    },
    '76': {
        name: 'NETZERSATZBETRIEB AKKU LEER (76)',
    },
    '77': {
        name: 'NETZERSATZBETRIEB FEHLER (77)',
    },
    '78': {
        name: 'INITIALISIERUNG (78)',
    },
    '79': {
        name: 'INSTALLATIONSMODUS (79)',
    },
    '80': {
        name: 'NETZAUSFALL (80)',
    },
    '81': {
        name: 'BMS UPDATE ERFORDERLICH (81)',
    },
    '82': {
        name: 'BMS KONFIGURATION ERFORDERLICH (82)',
    },
    '83': {
        name: 'ISOLATIONSTEST (83)',
    },
    '84': {
        name: 'SELBSTTEST (84)',
    },
    '85': {
        name: 'EXTERNE STEUERUNG (85)',
    },
    '86': {
        name: 'TEMPERATUR SENSOR FEHLER (86)',
    },
    '87': {
        name: 'NETZBETREIBER: LADEN GESPERRT (87)',
    },
    '88': {
        name: 'NETZBETREIBER: ENTLADEN GESPERRT (88)',
    },
    '89': {
        name: 'RESERVEKAPAZITÄT (89)',
    },
    '90': {
        name: 'SELBSTTEST FEHLER (90)',
    },
    '91': {
        name: 'ISOLATIONSFEHLER (91)',
    },
}

module.exports = mode_desc;
