"""Tests for BOQ accessory counting and the Type column, focused on
standard-duct -> high-static escalation: an escalated unit must be shown as
'High static pressure duct type' AND must count a drain pump + back filter,
because those accessories follow the *selected* unit, not the source type.

Run (needs openpyxl): .venv/Scripts/python.exe test_build_accessories.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import openpyxl  # noqa: E402
from build_boq import build  # noqa: E402

HIGH_STATIC_MODEL = "MMD-UP0961HP-E1"  # 28 kW
HIGH_STATIC_TYPE = "High static pressure duct type"


def _build(rows):
    out = os.path.join(tempfile.gettempdir(), "acc_test.xlsx")
    summary = build({"project": "Acc Test", "rows": rows}, out, 0.25, None)
    return summary, out


def _type_cell_for_model(out_path, model):
    """Return the Type-column (col 3) text of the BOQ row whose model (col 6) matches."""
    wb = openpyxl.load_workbook(out_path)
    ws = wb["VRF BOQ"]
    for row in ws.iter_rows(min_row=1, max_col=6, values_only=True):
        if row[5] == model:  # column F = Selected Model
            return row[2]     # column C = Type
    return None


def test_escalated_high_static_counts_drain_and_filter():
    summary, _ = _build([{"type": "ducted", "required_kw": 23.3, "qty": 1, "system": "S1"}])
    assert summary["drain_pumps"] == 1, summary
    assert summary["back_filters"] == 1, summary


def test_escalated_high_static_type_shown_in_boq():
    _, out = _build([{"type": "ducted", "required_kw": 23.3, "qty": 1, "system": "S1"}])
    t = _type_cell_for_model(out, HIGH_STATIC_MODEL)
    assert t == HIGH_STATIC_TYPE, f"Type column shows {t!r}, expected {HIGH_STATIC_TYPE!r}"


def test_escalated_accessories_scale_with_qty():
    summary, _ = _build([{"type": "ducted", "required_kw": 23.3, "qty": 3, "system": "S1"}])
    assert summary["drain_pumps"] == 3, summary
    assert summary["back_filters"] == 3, summary


def test_standard_duct_under_16_has_no_drain_or_filter():
    summary, _ = _build([{"type": "ducted", "required_kw": 14, "qty": 2, "system": "S1"}])
    assert summary["drain_pumps"] == 0, summary
    assert summary["back_filters"] == 0, summary


def test_explicit_high_static_still_counts():
    summary, _ = _build([{"type": "high static", "required_kw": 12, "qty": 1, "system": "S1"}])
    assert summary["drain_pumps"] == 1, summary
    assert summary["back_filters"] == 1, summary


def test_cassette_unaffected():
    summary, _ = _build([{"type": "4 way cassette", "required_kw": 14, "qty": 4, "system": "S1"}])
    assert summary["drain_pumps"] == 0, summary
    assert summary["back_filters"] == 0, summary
    assert summary["cassette_panels"] == 4, summary


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL  {name}: {e}")
    print(f"\n{('ALL PASS' if failures == 0 else str(failures) + ' FAILED')}")
    sys.exit(1 if failures else 0)
