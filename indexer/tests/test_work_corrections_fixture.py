import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "gen-work-corrections-fixture.py"
FIXTURE = REPO / "test-fixtures" / "work-corrections.json"


def test_committed_fixture_matches_the_generator(tmp_path):
    out = tmp_path / "fixture.json"
    subprocess.run([sys.executable, str(SCRIPT), "--out", str(out)], check=True, capture_output=True, text=True)
    assert json.loads(out.read_text()) == json.loads(FIXTURE.read_text())


def test_fixture_has_the_documented_shape():
    data = json.loads(FIXTURE.read_text())
    assert data["version"] == 2
    assert len(data["cases"]) == 200
    kinds = {step["op"]["kind"] for case in data["cases"] for step in case["steps"]}
    assert kinds == {"publish", "merge", "split", "reset", "stale"}
    for case in data["cases"]:
        editions = case["editions"]
        assert all(len(e) == 1 and "a" <= e <= "j" for e in editions)
        assert all(copy == edition.upper() and edition in editions for copy, edition in case["copies"].items())
        assert case["steps"][0]["op"]["kind"] == "publish"
        for step in case["steps"]:
            present = editions[:step["library"]]
            assert sorted(e for members in step["cards"].values() for e in members) == sorted(present)
            assert all(card in members for card, members in step["cards"].items())
            if step["op"]["kind"] == "publish":
                entries = present + [c for c, e in case["copies"].items() if e in present]
                assert sorted(step["catalogWorkId"]) == sorted(entries)
    grew = [(a["library"], b["library"]) for case in data["cases"] for a, b in zip(case["steps"], case["steps"][1:])]
    assert any(after > before for before, after in grew)


def test_known_bridge_split_case_is_recorded_correctly():
    # a-b and b-c are linked, a-c are not: splitting b must leave a and c together.
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--explain-bridge"], check=True, capture_output=True, text=True,
    )
    assert json.loads(result.stdout) == {"rows": {"a": "a", "b": "b", "c": "a"}, "cards": {"a": ["a", "c"], "b": ["b"]}}
