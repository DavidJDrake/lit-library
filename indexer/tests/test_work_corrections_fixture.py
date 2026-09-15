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
    assert data["version"] == 1
    assert len(data["cases"]) == 200
    kinds = {step["op"]["kind"] for case in data["cases"] for step in case["steps"]}
    assert kinds == {"merge", "split", "reset"}
    for case in data["cases"]:
        assert all(len(e) == 1 and "a" <= e <= "j" for e in case["editions"])
        assert set(case["catalogWorkId"]) == set(case["editions"])
        for step in case["steps"]:
            covered = sorted(e for card in step["cards"] for e in card)
            assert covered == sorted(case["editions"])


def test_known_bridge_split_case_is_recorded_correctly():
    # a-b and b-c are linked, a-c are not: splitting b must leave a and c together.
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--explain-bridge"], check=True, capture_output=True, text=True,
    )
    assert json.loads(result.stdout) == {"rows": {"b": "b", "c": "a"}, "cards": [["a", "c"], ["b"]]}
