"""Container loading calculator for Toshiba SMMS-e VRF projects.

Physical model
--------------
ODU single modules CANNOT be stacked: each sits on the container floor in a
single layer. We pack them in floor-length lanes -- modules stand side by side
across the interior width, and these rows repeat along the interior length.
The binding ODU constraint is therefore consumed FLOOR LENGTH, not volume.

IDU CAN be stacked: they fill the usable cargo volume (gross internal volume x
STOWAGE_FACTOR).

Weight is always a third constraint (max payload per container).

Containers required = ceil( max(odu_floor_driver, idu_volume_driver,
                                weight_driver) ).

A model's qty is decided once; ODU rows in a BOQ must already be decomposed
into their single MAP* modules before being passed here (the BOQ Prices tab
already does this decomposition, so reuse those module quantities).
"""

import math
from container_data import (CONTAINERS, DEFAULT_CONTAINER, STOWAGE_FACTOR,
                            ODU_DIMS, IDU_DIMS, DIMS)


def _odu_floor_length_per_module(model, cont):
    """Floor length (mm) one ODU module consumes, given how many fit across
    the container interior width side-by-side (lanes). Depth runs along length.

    Returns length consumed per module = module_depth / lanes_across.
    Orientation: width across container width, depth along length (modules are
    serviced front-to-back; this is the conventional Toshiba stow).
    """
    d = DIMS[model]
    lanes = max(1, int(cont["wid"] // d["w"]))   # modules side-by-side
    return d["d"] / lanes                         # length used per module


def calc_containers(model_qtys, container=DEFAULT_CONTAINER,
                    stowage=STOWAGE_FACTOR):
    """model_qtys: {model: qty} of SINGLE modules / IDU / etc.

    Returns a dict with per-driver detail and the final container count.
    Unknown models (no dimension data) are reported in `unknown_models` and
    skipped from the math.
    """
    cont = CONTAINERS[container]
    floor_len = cont["len"]
    usable_vol = (cont["len"] * cont["wid"] * cont["hgt"]) / 1e9 * stowage
    payload = cont["payload"]

    odu_len_used = 0.0     # mm of floor length consumed by non-stackable ODUs
    idu_vol_used = 0.0     # m3 of stackable cargo
    total_wt = 0.0
    unknown = []
    odu_units = idu_units = 0

    for model, qty in model_qtys.items():
        qty = int(qty)
        if qty <= 0:
            continue
        if model not in DIMS:
            unknown.append(model)
            continue
        d = DIMS[model]
        total_wt += d["wt"] * qty
        if model in ODU_DIMS:
            odu_len_used += _odu_floor_length_per_module(model, cont) * qty
            odu_units += qty
        else:
            idu_vol_used += d["vol"] * qty
            idu_units += qty

    cont_by_odu_floor = odu_len_used / floor_len if floor_len else 0
    cont_by_idu_vol = idu_vol_used / usable_vol if usable_vol else 0
    cont_by_weight = total_wt / payload if payload else 0

    driver_vals = {
        "odu_floor": cont_by_odu_floor,
        "idu_volume": cont_by_idu_vol,
        "weight": cont_by_weight,
    }
    governing = max(driver_vals, key=driver_vals.get)
    required = math.ceil(max(driver_vals.values()) - 1e-9) if any(
        v > 0 for v in driver_vals.values()) else 0

    return {
        "container": container,
        "stowage_factor": stowage,
        "usable_vol_per_container_m3": round(usable_vol, 3),
        "floor_length_mm": floor_len,
        "payload_per_container_kg": payload,
        "odu_modules": odu_units,
        "idu_units": idu_units,
        "odu_floor_length_used_mm": round(odu_len_used, 1),
        "idu_volume_used_m3": round(idu_vol_used, 3),
        "total_weight_kg": round(total_wt, 1),
        "containers_by_odu_floor": round(cont_by_odu_floor, 3),
        "containers_by_idu_volume": round(cont_by_idu_vol, 3),
        "containers_by_weight": round(cont_by_weight, 3),
        "governing_driver": governing,
        "containers_required": required,
        "unknown_models": unknown,
    }


if __name__ == "__main__":
    import json, sys
    # quick smoke test
    demo = {"MAP2006HT8P-ME": 6, "MAP1606HT8P-ME": 3,
            "MMU-UP0561HP-E": 20, "MMD-UP0561HP-E": 12}
    print(json.dumps(calc_containers(demo), indent=2))
