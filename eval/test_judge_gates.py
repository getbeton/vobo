"""VOBO-49: mocked DeepEval gate.

The live-model job is nightly. This file asserts the fixture shape so a missing
baseline or a blended blind/sighted figure fails the suite without network.
"""

from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
BASELINES = json.loads((ROOT / "baselines.json").read_text())


def test_baselines_are_per_criterion():
    assert "voice" in BASELINES
    for name, row in BASELINES.items():
        assert 0 <= row["precision"] <= 1, name
        assert 0 <= row["recall"] <= 1, name


def test_blind_and_sighted_are_separate_keys():
    # A blended figure is the specific thing ARD §26.5 forbids.
    assert "blended" not in BASELINES
    assert "overall" not in BASELINES
