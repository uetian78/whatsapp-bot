"""Tests for indoor-unit selection, focused on the standard-duct -> high-static
escalation rule: a standard duct load larger than the biggest standard duct
model (16 kW) must be served by a single high static pressure duct unit, not by
splitting into multiple standard ducts.

Run: python test_select_idu.py   (from the engine/ directory)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402


def test_standard_duct_over_16_uses_single_high_static():
    sel = engine.select_idu("Standard duct type", 23.3)
    assert len(sel) == 1, f"expected one unit, got {len(sel)}: {sel}"
    assert sel[0]["type"] == "High static pressure duct type", sel
    assert sel[0]["model"] == "MMD-UP0961HP-E1", sel  # 28 kW
    assert sel[0]["t1"] == 28, sel


def test_standard_duct_just_over_16_picks_smallest_high_static_that_fits():
    sel = engine.select_idu("Standard duct type", 17)
    assert len(sel) == 1, sel
    assert sel[0]["type"] == "High static pressure duct type", sel
    assert sel[0]["model"] == "MMD-UP0721HP-E1", sel  # 22.4 kW
    assert sel[0]["t1"] == 22.4, sel


def test_standard_duct_at_16_stays_standard():
    sel = engine.select_idu("Standard duct type", 16)
    assert len(sel) == 1, sel
    assert sel[0]["type"] == "Standard duct type", sel
    assert sel[0]["model"] == "MMD-UP0561BHP-E", sel  # 16 kW


def test_standard_duct_under_16_unchanged():
    sel = engine.select_idu("Standard duct type", 14)
    assert len(sel) == 1, sel
    assert sel[0]["type"] == "Standard duct type", sel
    assert sel[0]["model"] == "MMD-UP0481BHP-E", sel  # 14 kW


def test_standard_duct_above_largest_high_static_splits_high_static():
    # 50 kW > 28 kW (largest high static) -> escalate, then split high static.
    sel = engine.select_idu("Standard duct type", 50)
    assert len(sel) == 2, sel
    assert all(s["type"] == "High static pressure duct type" for s in sel), sel
    assert all(s["model"] == "MMD-UP0961HP-E1" for s in sel), sel  # 28 kW each


def test_explicit_high_static_unchanged():
    sel = engine.select_idu("High static pressure duct type", 23.3)
    assert len(sel) == 1, sel
    assert sel[0]["model"] == "MMD-UP0961HP-E1", sel


def test_cassette_over_max_still_splits_same_type():
    # The escalation is standard-duct-specific; other types keep splitting.
    sel = engine.select_idu("4-way cassette type", 60)
    assert len(sel) >= 2, sel
    assert all(s["type"] == "4-way cassette type" for s in sel), sel


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
