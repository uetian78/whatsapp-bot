"""Deterministic Toshiba VRF selection engine.

Pure logic only: type normalization, indoor selection at rated capacity,
outdoor selection at T3, and the split rule. No pricing (prices left blank
per project instruction). Same input -> same output, every time.
"""

import math
from vrf_data import IDU, ODU, ODU_T3_CEILING

# ---------------------------------------------------------------------------
# Type normalization. Free-text from the schedule -> exact catalogue type.
# Order matters: more specific patterns are checked first. Default = ducted.
# ---------------------------------------------------------------------------
# Each entry: (catalogue_type, [substrings that map to it]). All matching is
# done on a lowercased, space-collapsed version of the input string.
_TYPE_RULES = [
    ("High static pressure duct type",
        ["high static", "hsd", "high-static", "high stat", "hs duct", "high static duct"]),
    ("Slim duct type",
        ["slim duct", "slim", "low static", "concealed slim"]),
    ("Standard duct type",
        ["standard duct", "ducted", "duct", "concealed", "ceiling concealed"]),
    ("Compact 4-way cassette",
        ["compact cassette", "compact 4", "compact four", "compact"]),
    ("1-way cassette type",
        ["1 way", "1-way", "one way", "single way", "1way"]),
    ("2-way cassette type",
        ["2 way", "2-way", "two way", "2way"]),
    ("4-way cassette type",
        ["4 way", "4-way", "four way", "cassette", "4way", "ceiling cassette"]),
    ("Hi-Wall",
        ["hi-wall", "hi wall", "high wall", "wall mounted", "wall-mounted", "wall"]),
    ("Ceiling type",
        ["ceiling suspended", "under ceiling", "exposed ceiling", "ceiling type", "ceiling"]),
    ("Floor standing type",
        ["floor standing", "floor-standing", "floor mounted", "floor", "vertical"]),
]

DEFAULT_TYPE = "Standard duct type"

CASSETTE_TYPES = {
    "4-way cassette type", "Compact 4-way cassette",
    "2-way cassette type", "1-way cassette type",
}
HI_WALL_TYPE = "Hi-Wall"
HIGH_STATIC_TYPE = "High static pressure duct type"


def normalize_type(raw):
    """Map free-text indoor type to an exact catalogue type string.

    Empty/None -> default (Standard duct type). Unknown text -> default.
    Returns (catalogue_type, matched_flag).
    """
    if raw is None:
        return DEFAULT_TYPE, False
    s = " ".join(str(raw).lower().split())
    if not s:
        return DEFAULT_TYPE, False
    for ctype, keys in _TYPE_RULES:
        for k in keys:
            if k in s:
                return ctype, True
    return DEFAULT_TYPE, False


# ---------------------------------------------------------------------------
# Indoor selection: smallest model of the type whose rated (T1) capacity is
# >= required. Selection is on rated indoor capacity (T1 column) per spec.
# If required exceeds the largest model of the type -> use multiple units.
# ---------------------------------------------------------------------------
def _idu_models(ctype):
    rows = [m for m in IDU if m["type"] == ctype]
    rows.sort(key=lambda m: m["t1"])
    return rows


def select_idu(ctype, required_kw):
    """Return a list of selected indoor unit dicts covering required_kw.

    Each element: {model, type, t1, t3, hp, cap_kw}. Normally length 1.
    Length > 1 only when required_kw exceeds the largest model of the type;
    in that case it splits into N near-even loads and selects each.
    """
    models = _idu_models(ctype)
    if not models:
        return [{"model": "Model Not Found", "type": ctype, "t1": 0, "t3": 0,
                 "hp": 0, "cap_kw": 0, "req_kw": required_kw}]
    largest = models[-1]
    if required_kw <= largest["t1"]:
        chosen = next(m for m in models if m["t1"] >= required_kw - 1e-9)
        return [{"model": chosen["model"], "type": ctype, "t1": chosen["t1"],
                 "t3": chosen["t3"], "hp": chosen["hp"], "cap_kw": chosen["t1"],
                 "req_kw": required_kw}]
    # required exceeds the biggest single indoor -> multiple identical-ish units
    n = math.ceil(required_kw / largest["t1"])
    per = required_kw / n
    chosen = next((m for m in models if m["t1"] >= per - 1e-9), largest)
    return [{"model": chosen["model"], "type": ctype, "t1": chosen["t1"],
             "t3": chosen["t3"], "hp": chosen["hp"], "cap_kw": chosen["t1"],
             "req_kw": per} for _ in range(n)]


# ---------------------------------------------------------------------------
# Outdoor selection at T3 (46 degC). Required = sum of indoor REQUIRED kw of
# the system. Pick smallest ODU with T3 >= required. If required
# exceeds the single-ODU ceiling, split by 2, then by 3.
# (Diversity removed per project instruction.)
# ---------------------------------------------------------------------------
def _odu_sorted():
    rows = list(ODU)
    rows.sort(key=lambda m: m["t3"])
    return rows


def _pick_single_odu(required_kw):
    for m in _odu_sorted():
        if m["t3"] >= required_kw - 1e-9:
            return m
    return None


def select_odu(required_kw):
    """Return a list of ODU dicts for one system's required T3 load.

    1 ODU if required <= ceiling. Else split by 2; if each half still
    > ceiling, split by 3. Each element carries the per-ODU required share.
    """
    if required_kw <= ODU_T3_CEILING + 1e-9:
        m = _pick_single_odu(required_kw)
        return [_odu_out(m, required_kw)]
    # divide by 2
    half = required_kw / 2.0
    if half <= ODU_T3_CEILING + 1e-9:
        m = _pick_single_odu(half)
        return [_odu_out(m, half), _odu_out(m, half)]
    # divide by 3
    third = required_kw / 3.0
    m = _pick_single_odu(third)
    if m is None:
        m = _odu_sorted()[-1]
    return [_odu_out(m, third), _odu_out(m, third), _odu_out(m, third)]


def _odu_out(m, req):
    if m is None:
        return {"model": "Model Not Found", "series": "", "t1": 0, "t3": 0,
                "hp": 0, "modules": "", "req_kw": req}
    return {"model": m["model"], "series": m["series"], "t1": m["t1"],
            "t3": m["t3"], "hp": m["hp"], "modules": m.get("modules", ""),
            "req_kw": req}
