import importlib.util
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "notify-books-added.py"


def load_module():
    spec = importlib.util.spec_from_file_location("notify_books_added", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_new_book_ids_and_payload_cap():
    m = load_module()
    before = {"a": "2026-01-01"}
    added = {"a": "2026-01-01", **{f"b{i:02d}": "2026-09-05" for i in range(25)}}
    ids = m.new_book_ids(before, added)
    assert len(ids) == 25 and ids == sorted(ids)
    payload = m.build_payload(ids)
    assert payload == {"source": "indexer", "type": "books_added", "count": 25, "bookIds": ids[:20]}


def run(tmp_path, before, added, *extra):
    b = tmp_path / "before.json"
    a = tmp_path / "added.json"
    b.write_text(json.dumps(before))
    a.write_text(json.dumps(added))
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--before", str(b), "--added", str(a), *extra],
        capture_output=True, text=True,
    )


def test_dry_run_prints_payload_and_no_delta_is_a_noop(tmp_path):
    r = run(tmp_path, {"a": "x"}, {"a": "x", "b": "y"}, "--dry-run")
    assert r.returncode == 0
    assert json.loads(r.stdout.strip().splitlines()[-1]) == {"source": "indexer", "type": "books_added", "count": 1, "bookIds": ["b"]}
    r = run(tmp_path, {"a": "x"}, {"a": "x"}, "--dry-run")
    assert r.returncode == 0 and "nothing to notify" in r.stdout


def test_missing_outputs_is_a_warning_not_a_failure(tmp_path):
    r = run(tmp_path, {}, {"b": "y"}, "--outputs", str(tmp_path / "missing.json"))
    assert r.returncode == 0
    assert "warning" in r.stderr
