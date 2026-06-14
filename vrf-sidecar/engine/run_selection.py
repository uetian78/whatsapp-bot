"""Single entry point for the WhatsApp bot.

Wraps parse_schedule + build_boq into one call so the bot layer never has to
know the engine internals or shell out to a subprocess.

    from run_selection import run_from_text
    result = run_from_text(raw_schedule_text, project="Villa 2601",
                           discount=0.25, out_dir="/tmp")
    # -> {"output": "/tmp/Villa_2601_VRF_BOQ.xlsx", "summary": {...},
    #     "warnings": [...], "excluded": [...]}

Recalculation note: build_boq writes live Excel formulas but does NOT compute
them. Cached values are blank until a calc engine opens the file. If the bot
must send a file with computed totals, run LibreOffice headless (see CLAUDE.md)
or the xlsx recalc script before delivery.
"""

import os
import re

from parse_schedule import parse_text
from build_boq import build


def _safe_name(project):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", project).strip("_") or "VRF_Project"


def run_from_text(raw, project="VRF Project", discount=0.25,
                  out_dir="/tmp", price_list_path=None):
    parsed = parse_text(raw, project=project, discount=discount)
    inp = parsed["input"]
    out_path = os.path.join(out_dir, f"{_safe_name(project)}_VRF_BOQ.xlsx")
    summary = build(inp, out_path, discount=discount,
                    price_list_path=price_list_path)
    return {
        "output": out_path,
        "summary": summary,
        "warnings": parsed["warnings"],
        "excluded": parsed["excluded"],
    }


def run_from_input(inp, project=None, discount=None, out_dir="/tmp",
                   price_list_path=None):
    """When the schedule is already structured engine JSON (e.g. parsed from
    an image by the bot's vision step)."""
    project = project or inp.get("project", "VRF Project")
    discount = discount if discount is not None else inp.get("discount", 0.25)
    out_path = os.path.join(out_dir, f"{_safe_name(project)}_VRF_BOQ.xlsx")
    summary = build(inp, out_path, discount=discount,
                    price_list_path=price_list_path)
    return {"output": out_path, "summary": summary, "warnings": [], "excluded": []}
