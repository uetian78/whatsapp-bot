"""Turn a raw schedule (CSV / TSV / pasted text) into engine input.json.

This is the bridge between a WhatsApp message and build_boq.py. It applies the
project rules that normally happen by hand in chat:

  * TR -> kW conversion (x3.517) when a row is given in tons of refrigeration.
  * Multi-room strings ("DINING + MAJLIS + PANTRY") -> qty = number of rooms.
  * Non-VRF rooms (split units, e.g. "Outside Kitchen") -> excluded.
  * System grouping carried straight through from the schedule.

It is intentionally forgiving about column names. Anything it cannot confidently
map is reported in `warnings` so the bot can ask the user to confirm rather than
guessing silently.

Usage:
    from parse_schedule import parse_text
    result = parse_text(raw_string, project="Villa 2601", discount=0.25)
    # result == {"input": {...engine json...}, "warnings": [...], "excluded": [...]}
"""

import csv
import io
import re

TR_TO_KW = 3.517

# Rooms that are NOT on the VRF system (handled by split units etc.).
# Matched as a lowercase substring of the room name.
NON_VRF_ROOM_PATTERNS = [
    "outside kitchen", "split", "split unit", "non-vrf", "non vrf",
]

# Column-header synonyms -> canonical field. Lowercased substring match.
_HEADER_MAP = {
    "tag":      ["tag", "unit tag", "ref", "id", "iu", "unit"],
    "system":   ["system", "sys", "odu", "outdoor", "group"],
    "room":     ["room", "area", "location", "space", "zone"],
    "type":     ["type", "indoor type", "idu type", "unit type", "model type"],
    "kw":       ["kw", "kilowatt", "cooling kw", "capacity kw", "load kw", "duty"],
    "tr":       ["tr", "ton", "tons", "tonnage", "refrigeration"],
    "qty":      ["qty", "quantity", "nos", "no.", "count", "number"],
}


def _canon_header(h):
    h = (h or "").strip().lower()
    for field, keys in _HEADER_MAP.items():
        for k in keys:
            if k == h or k in h:
                return field
    return None


def _is_non_vrf(room):
    r = (room or "").lower()
    return any(p in r for p in NON_VRF_ROOM_PATTERNS)


def _room_qty(room):
    """Multi-room string -> number of rooms. 'A + B + PANTRY' -> 3."""
    if not room:
        return 1
    parts = [p for p in re.split(r"[+/&,]| and ", room) if p.strip()]
    return max(1, len(parts))


def _to_float(v):
    if v is None:
        return None
    try:
        return float(str(v).strip().replace(",", ""))
    except (ValueError, AttributeError):
        return None


def _detect_delimiter(text):
    first = text.strip().splitlines()[0] if text.strip() else ""
    if "\t" in first:
        return "\t"
    if first.count(";") > first.count(","):
        return ";"
    return ","


def parse_text(raw, project="VRF Project", discount=0.25):
    """Parse delimited text into engine input. Returns dict with input/warnings/excluded."""
    warnings = []
    excluded = []
    text = (raw or "").strip()
    if not text:
        return {"input": {"project": project, "discount": discount, "rows": []},
                "warnings": ["empty schedule"], "excluded": []}

    delim = _detect_delimiter(text)
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    table = [row for row in reader if any((c or "").strip() for c in row)]
    if not table:
        return {"input": {"project": project, "discount": discount, "rows": []},
                "warnings": ["no data rows"], "excluded": []}

    header = [_canon_header(c) for c in table[0]]
    has_header = any(h for h in header)
    if not has_header:
        warnings.append("no recognizable header row; assuming order: "
                        "tag, system, room, type, kw, qty")
        header = ["tag", "system", "room", "type", "kw", "qty"]
        data_rows = table
    else:
        data_rows = table[1:]

    col = {field: header.index(field) for field in set(header) if field}

    def cell(row, field):
        idx = col.get(field)
        if idx is None or idx >= len(row):
            return None
        v = row[idx]
        return v.strip() if isinstance(v, str) else v

    rows = []
    auto_sys = 0
    for raw_row in data_rows:
        room = cell(raw_row, "room") or ""
        rtype = cell(raw_row, "type") or ""

        if _is_non_vrf(room) or _is_non_vrf(rtype):
            excluded.append(room or rtype)
            continue

        kw = _to_float(cell(raw_row, "kw"))
        tr = _to_float(cell(raw_row, "tr"))
        if kw is None and tr is not None:
            kw = round(tr * TR_TO_KW, 2)
        if kw is None:
            warnings.append(f"row '{room or rtype or raw_row}': no capacity (kw/TR) found; skipped")
            continue

        explicit_qty = _to_float(cell(raw_row, "qty"))
        qty = int(explicit_qty) if explicit_qty else _room_qty(room)

        system = cell(raw_row, "system")
        if not system:
            auto_sys += 1
            system = f"S{auto_sys}"
            warnings.append(f"row '{room}': no system specified; assigned {system}")

        rows.append({
            "tag": cell(raw_row, "tag") or "",
            "system": str(system),
            "room": room,
            "type": rtype or "ducted",
            "required_kw": kw,
            "qty": qty,
        })

    return {
        "input": {"project": project, "discount": discount, "rows": rows},
        "warnings": warnings,
        "excluded": excluded,
    }


if __name__ == "__main__":
    import json
    import sys
    raw = sys.stdin.read()
    out = parse_text(raw, project=sys.argv[1] if len(sys.argv) > 1 else "VRF Project")
    print(json.dumps(out, indent=2))
