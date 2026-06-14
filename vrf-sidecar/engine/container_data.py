"""Toshiba SMMS-e shipping dimensions + container reference.

Auto-extracted from SMMSe_Container_Loading.xlsx. Single source of truth for
container loading. Do not hand-key; regenerate from the catalogue Excel.

Two physical rules govern packing:
  * ODU single modules CANNOT be stacked  -> floor-footprint (lane) driven.
  * IDU CAN be stacked                     -> usable-volume driven.
Container count = max(ODU floor lanes, IDU volume, total weight).
"""

# Standard ISO dry-box INTERNAL dims (mm) + payload (kg). Edit if line differs.
CONTAINERS = {
    "20'GP": {"len": 5900,  "wid": 2350, "hgt": 2390, "payload": 28000},
    "40'GP": {"len": 12030, "wid": 2350, "hgt": 2390, "payload": 26500},
    "40'HC": {"len": 12030, "wid": 2350, "hgt": 2690, "payload": 26500},
}
DEFAULT_CONTAINER = "40'HC"
STOWAGE_FACTOR = 0.65   # usable volume fraction for stackable IDU cargo

ODU_DIMS = {
    'MAP0806HT8P-ME': {'h': 1800, 'w': 990, 'd': 780, 'wt': 242, 'vol': 1.38996},
    'MAP1006HT8P-ME': {'h': 1800, 'w': 990, 'd': 780, 'wt': 242, 'vol': 1.38996},
    'MAP1206HT8P-ME': {'h': 1800, 'w': 990, 'd': 780, 'wt': 242, 'vol': 1.38996},
    'MAP1406HT8P-ME': {'h': 1800, 'w': 1210, 'd': 780, 'wt': 299, 'vol': 1.69884},
    'MAP1606HT8P-ME': {'h': 1800, 'w': 1210, 'd': 780, 'wt': 299, 'vol': 1.69884},
    'MAP1806HT8P-ME': {'h': 1800, 'w': 1600, 'd': 780, 'wt': 370, 'vol': 2.2464},
    'MAP2006HT8P-ME': {'h': 1800, 'w': 1600, 'd': 780, 'wt': 370, 'vol': 2.2464},
}

IDU_DIMS = {
    'MMU-UP0091HP-E': {'h': 256, 'w': 840, 'd': 840, 'wt': 18, 'vol': 0.180634},
    'MMU-UP0121HP-E': {'h': 256, 'w': 840, 'd': 840, 'wt': 18, 'vol': 0.180634},
    'MMU-UP0151HP-E': {'h': 256, 'w': 840, 'd': 840, 'wt': 20, 'vol': 0.180634},
    'MMU-UP0181HP-E': {'h': 256, 'w': 840, 'd': 840, 'wt': 20, 'vol': 0.180634},
    'MMU-UP0241HP-E': {'h': 256, 'w': 840, 'd': 840, 'wt': 20, 'vol': 0.180634},
    'MMU-UP0271HP-E': {'h': 256, 'w': 840, 'd': 840, 'wt': 20, 'vol': 0.180634},
    'MMU-UP0301HP-E': {'h': 256, 'w': 840, 'd': 840, 'wt': 20, 'vol': 0.180634},
    'MMU-UP0361HP-E': {'h': 319, 'w': 840, 'd': 840, 'wt': 25, 'vol': 0.225086},
    'MMU-UP0481HP-E': {'h': 319, 'w': 840, 'd': 840, 'wt': 25, 'vol': 0.225086},
    'MMU-UP0561HP-E': {'h': 319, 'w': 840, 'd': 840, 'wt': 25, 'vol': 0.225086},
    'MMU-UP0071MH-E': {'h': 256, 'w': 575, 'd': 575, 'wt': 15, 'vol': 0.08464},
    'MMU-UP0091MH-E': {'h': 256, 'w': 575, 'd': 575, 'wt': 15, 'vol': 0.08464},
    'MMU-UP0121MH-E': {'h': 256, 'w': 575, 'd': 575, 'wt': 15, 'vol': 0.08464},
    'MMU-UP0151MH-E': {'h': 256, 'w': 575, 'd': 575, 'wt': 15, 'vol': 0.08464},
    'MMU-UP0181MH-E': {'h': 256, 'w': 575, 'd': 575, 'wt': 15, 'vol': 0.08464},
    'MMU-UP0071WH-E': {'h': 295, 'w': 815, 'd': 570, 'wt': 19, 'vol': 0.137042},
    'MMU-UP0091WH-E': {'h': 295, 'w': 815, 'd': 570, 'wt': 19, 'vol': 0.137042},
    'MMU-UP0121WH-E': {'h': 295, 'w': 815, 'd': 570, 'wt': 19, 'vol': 0.137042},
    'MMU-UP0151WH-E': {'h': 295, 'w': 815, 'd': 570, 'wt': 19, 'vol': 0.137042},
    'MMU-UP0181WH-E': {'h': 345, 'w': 1180, 'd': 570, 'wt': 26, 'vol': 0.232047},
    'MMU-UP0241WH-E': {'h': 345, 'w': 1180, 'd': 570, 'wt': 26, 'vol': 0.232047},
    'MMU-UP0271WH-E': {'h': 345, 'w': 1180, 'd': 570, 'wt': 26, 'vol': 0.232047},
    'MMU-UP0301WH-E': {'h': 345, 'w': 1180, 'd': 570, 'wt': 26, 'vol': 0.232047},
    'MMU-UP0361WH-E': {'h': 345, 'w': 1600, 'd': 570, 'wt': 36, 'vol': 0.31464},
    'MMU-UP0481WH-E': {'h': 345, 'w': 1600, 'd': 570, 'wt': 36, 'vol': 0.31464},
    'MMU-UP0561WH-E': {'h': 345, 'w': 1600, 'd': 570, 'wt': 36, 'vol': 0.31464},
    'MMU-UP0071YHP-E': {'h': 150, 'w': 990, 'd': 450, 'wt': 14, 'vol': 0.066825},
    'MMU-UP0091YHP-E': {'h': 150, 'w': 990, 'd': 450, 'wt': 14, 'vol': 0.066825},
    'MMU-UP0121YHP-E': {'h': 150, 'w': 990, 'd': 450, 'wt': 14, 'vol': 0.066825},
    'MMU-UP0151SH-E': {'h': 200, 'w': 1000, 'd': 710, 'wt': 21, 'vol': 0.142},
    'MMU-UP0181SH-E': {'h': 200, 'w': 1000, 'd': 710, 'wt': 21, 'vol': 0.142},
    'MMU-UP0241SH-E': {'h': 200, 'w': 1000, 'd': 710, 'wt': 22, 'vol': 0.142},
    'MMD-UP0071BHP-E': {'h': 275, 'w': 700, 'd': 750, 'wt': 23, 'vol': 0.144375},
    'MMD-UP0091BHP-E': {'h': 275, 'w': 700, 'd': 750, 'wt': 23, 'vol': 0.144375},
    'MMD-UP0121BHP-E': {'h': 275, 'w': 700, 'd': 750, 'wt': 23, 'vol': 0.144375},
    'MMD-UP0151BHP-E': {'h': 275, 'w': 700, 'd': 750, 'wt': 23, 'vol': 0.144375},
    'MMD-UP0181BHP-E': {'h': 275, 'w': 700, 'd': 750, 'wt': 23, 'vol': 0.144375},
    'MMD-UP0241BHP-E': {'h': 275, 'w': 1000, 'd': 750, 'wt': 30, 'vol': 0.20625},
    'MMD-UP0271BHP-E': {'h': 275, 'w': 1000, 'd': 750, 'wt': 30, 'vol': 0.20625},
    'MMD-UP0301BHP-E': {'h': 275, 'w': 1000, 'd': 750, 'wt': 30, 'vol': 0.20625},
    'MMD-UP0361BHP-E': {'h': 275, 'w': 1400, 'd': 750, 'wt': 40, 'vol': 0.28875},
    'MMD-UP0481BHP-E': {'h': 275, 'w': 1400, 'd': 750, 'wt': 40, 'vol': 0.28875},
    'MMD-UP0561BHP-E': {'h': 275, 'w': 1400, 'd': 750, 'wt': 40, 'vol': 0.28875},
    'MMD-UP0181HP-E': {'h': 298, 'w': 1000, 'd': 750, 'wt': 34, 'vol': 0.2235},
    'MMD-UP0241HP-E': {'h': 298, 'w': 1000, 'd': 750, 'wt': 34, 'vol': 0.2235},
    'MMD-UP0271HP-E': {'h': 298, 'w': 1000, 'd': 750, 'wt': 34, 'vol': 0.2235},
    'MMD-UP0361HP-E': {'h': 298, 'w': 1400, 'd': 750, 'wt': 43, 'vol': 0.3129},
    'MMD-UP0481HP-E': {'h': 298, 'w': 1400, 'd': 750, 'wt': 43, 'vol': 0.3129},
    'MMD-UP0561HP-E': {'h': 298, 'w': 1400, 'd': 750, 'wt': 43, 'vol': 0.3129},
    'MMD-UP0726HP-E': {'h': 448, 'w': 1400, 'd': 900, 'wt': 97, 'vol': 0.56448},
    'MMD-UP0966HP-E': {'h': 448, 'w': 1400, 'd': 900, 'wt': 97, 'vol': 0.56448},
    'MMD-UP0071SPHY-E': {'h': 210, 'w': 700, 'd': 450, 'wt': 16, 'vol': 0.06615},
    'MMD-UP0091SPHY-E': {'h': 210, 'w': 700, 'd': 450, 'wt': 16, 'vol': 0.06615},
    'MMD-UP0121SPHY-E': {'h': 210, 'w': 700, 'd': 450, 'wt': 16, 'vol': 0.06615},
    'MMD-UP0151SPHY-E': {'h': 210, 'w': 900, 'd': 450, 'wt': 18, 'vol': 0.08505},
    'MMD-UP0181SPHY-E': {'h': 210, 'w': 900, 'd': 450, 'wt': 18, 'vol': 0.08505},
    'MMD-UP0241SPHY-E': {'h': 210, 'w': 1110, 'd': 450, 'wt': 21, 'vol': 0.104895},
    'MMD-UP0271SPHY-E': {'h': 210, 'w': 1110, 'd': 450, 'wt': 21, 'vol': 0.104895},
    'MMC-UP0151HP-E': {'h': 235, 'w': 950, 'd': 690, 'wt': 24, 'vol': 0.154042},
    'MMC-UP0181HP-E': {'h': 235, 'w': 950, 'd': 690, 'wt': 24, 'vol': 0.154042},
    'MMC-UP0241HP-E': {'h': 235, 'w': 1270, 'd': 690, 'wt': 30, 'vol': 0.20593},
    'MMC-UP0271HP-E': {'h': 235, 'w': 1270, 'd': 690, 'wt': 30, 'vol': 0.20593},
    'MMC-UP0361HP-E': {'h': 235, 'w': 1586, 'd': 690, 'wt': 39, 'vol': 0.25717},
    'MMC-UP0481HP-E': {'h': 235, 'w': 1586, 'd': 690, 'wt': 39, 'vol': 0.25717},
    'MMC-UP0561HP-E': {'h': 235, 'w': 1586, 'd': 690, 'wt': 39, 'vol': 0.25717},
    'MMK-UP0071HP-E': {'h': 293, 'w': 798, 'd': 230, 'wt': 11, 'vol': 0.053777},
    'MMK-UP0091HP-E': {'h': 293, 'w': 798, 'd': 230, 'wt': 11, 'vol': 0.053777},
    'MMK-UP0121HP-E': {'h': 293, 'w': 798, 'd': 230, 'wt': 11, 'vol': 0.053777},
    'MMK-UP0151HP-E': {'h': 320, 'w': 1050, 'd': 250, 'wt': 16, 'vol': 0.084},
    'MMK-UP0181HP-E': {'h': 320, 'w': 1050, 'd': 250, 'wt': 16, 'vol': 0.084},
    'MMK-UP0241HP-E': {'h': 320, 'w': 1050, 'd': 250, 'wt': 16, 'vol': 0.084},
    'MMK-UP0271HP-E': {'h': 350, 'w': 1200, 'd': 280, 'wt': 20, 'vol': 0.1176},
    'MMK-UP0301HP-E': {'h': 350, 'w': 1200, 'd': 280, 'wt': 20, 'vol': 0.1176},
    'MMK-UP0361HP-E': {'h': 350, 'w': 1200, 'd': 280, 'wt': 20, 'vol': 0.1176},
    'MMF-UP0151H-E': {'h': 1750, 'w': 600, 'd': 210, 'wt': 46, 'vol': 0.2205},
    'MMF-UP0181H-E': {'h': 1750, 'w': 600, 'd': 210, 'wt': 46, 'vol': 0.2205},
    'MMF-UP0241H-E': {'h': 1750, 'w': 600, 'd': 210, 'wt': 47, 'vol': 0.2205},
    'MMF-UP0271H-E': {'h': 1750, 'w': 600, 'd': 210, 'wt': 47, 'vol': 0.2205},
    'MMF-UP0361H-E': {'h': 1750, 'w': 600, 'd': 390, 'wt': 62, 'vol': 0.4095},
    'MMF-UP0481H-E': {'h': 1750, 'w': 600, 'd': 390, 'wt': 62, 'vol': 0.4095},
    'MMF-UP0561H-E': {'h': 1750, 'w': 600, 'd': 390, 'wt': 62, 'vol': 0.4095},
    'MMD-UP0481HFP-E': {'h': 327, 'w': 1430, 'd': 750, 'wt': 44, 'vol': 0.350708},
    'MMD-UP0721HFP-E': {'h': 477, 'w': 1430, 'd': 900, 'wt': 99, 'vol': 0.613899},
    'MMD-UP0961HFP-E': {'h': 477, 'w': 1430, 'd': 900, 'wt': 99, 'vol': 0.613899},
    'MML-UP0071NHP-E': {'h': 600, 'w': 700, 'd': 220, 'wt': 17, 'vol': 0.0924},
    'MML-UP0091NHP-E': {'h': 600, 'w': 700, 'd': 220, 'wt': 17, 'vol': 0.0924},
    'MML-UP0121NHP-E': {'h': 600, 'w': 700, 'd': 220, 'wt': 17, 'vol': 0.0924},
    'MML-UP0151NHP-E': {'h': 600, 'w': 700, 'd': 220, 'wt': 17, 'vol': 0.0924},
    'MML-UP0181NHP-E': {'h': 600, 'w': 700, 'd': 220, 'wt': 17, 'vol': 0.0924},
    'MML-UP0071H-E': {'h': 630, 'w': 950, 'd': 230, 'wt': 37, 'vol': 0.137655},
    'MML-UP0091H-E': {'h': 630, 'w': 950, 'd': 230, 'wt': 37, 'vol': 0.137655},
    'MML-UP0121H-E': {'h': 630, 'w': 950, 'd': 230, 'wt': 37, 'vol': 0.137655},
    'MML-UP0151H-E': {'h': 630, 'w': 950, 'd': 230, 'wt': 37, 'vol': 0.137655},
    'MML-UP0181H-E': {'h': 630, 'w': 950, 'd': 230, 'wt': 40, 'vol': 0.137655},
    'MML-UP0241H-E': {'h': 630, 'w': 950, 'd': 230, 'wt': 40, 'vol': 0.137655},
    'MML-UP0071BH-E': {'h': 600, 'w': 745, 'd': 220, 'wt': 21, 'vol': 0.09834},
    'MML-UP0091BH-E': {'h': 600, 'w': 745, 'd': 220, 'wt': 21, 'vol': 0.09834},
    'MML-UP0121BH-E': {'h': 600, 'w': 745, 'd': 220, 'wt': 21, 'vol': 0.09834},
    'MML-UP0151BH-E': {'h': 600, 'w': 1045, 'd': 220, 'wt': 29, 'vol': 0.13794},
    'MML-UP0181BH-E': {'h': 600, 'w': 1045, 'd': 220, 'wt': 29, 'vol': 0.13794},
    'MML-UP0241BH-E': {'h': 600, 'w': 1045, 'd': 220, 'wt': 29, 'vol': 0.13794},
}

DIMS = {**ODU_DIMS, **IDU_DIMS}

# Catalogue (vrf_data) uses a different code revision for the two largest high
# static ducted units than the dimension sheet. Same physical unit -> alias so
# container loading resolves them instead of dropping them as "unknown".
_DIM_ALIASES = {
    "MMD-UP0721HP-E1": "MMD-UP0726HP-E",
    "MMD-UP0961HP-E1": "MMD-UP0966HP-E",
}
for _alias, _real in _DIM_ALIASES.items():
    if _real in DIMS and _alias not in DIMS:
        DIMS[_alias] = DIMS[_real]
