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


def test_missing_added_is_a_warning_not_a_failure(tmp_path):
    b = tmp_path / "before.json"
    b.write_text(json.dumps({}))
    missing_added = tmp_path / "added.json"
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--before", str(b), "--added", str(missing_added)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert "warning" in r.stderr


def test_corrupt_added_is_a_warning_not_a_failure(tmp_path):
    b = tmp_path / "before.json"
    a = tmp_path / "added.json"
    b.write_text(json.dumps({}))
    a.write_text("{not valid json")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--before", str(b), "--added", str(a)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert "warning" in r.stderr


def test_corrupt_before_is_a_warning_not_a_failure(tmp_path):
    b = tmp_path / "before.json"
    a = tmp_path / "added.json"
    b.write_text("{not valid json")
    a.write_text(json.dumps({"b": "y"}))
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--before", str(b), "--added", str(a)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert "warning" in r.stderr


# Valid JSON of the wrong shape used to crash new_book_ids() (set(added) - set(before)
# runs outside the read try/except blocks), because the reads never checked they got a
# JSON object back. These shapes are chosen to genuinely reproduce that: a list of dicts
# (dicts are unhashable, so set() on it raises TypeError), a bare number (not iterable),
# and null (also not iterable). A list of plain integers would NOT reproduce it -- ints
# are hashable, so set() on it silently succeeds -- which is why the earlier round's tests
# (a list of integers) missed this.
def test_added_as_a_list_of_objects_is_a_warning_not_a_failure(tmp_path):
    r = run(tmp_path, {}, [{"id": "b1"}])
    assert r.returncode == 0
    assert "warning" in r.stderr


def test_added_as_a_bare_number_is_a_warning_not_a_failure(tmp_path):
    r = run(tmp_path, {}, 5)
    assert r.returncode == 0
    assert "warning" in r.stderr


def test_before_as_a_list_is_a_warning_not_a_failure(tmp_path):
    r = run(tmp_path, [{"x": 1}], {"a": "x"})
    assert r.returncode == 0
    assert "warning" in r.stderr


def test_added_as_null_is_a_warning_not_a_failure(tmp_path):
    r = run(tmp_path, {}, None)
    assert r.returncode == 0
    assert "warning" in r.stderr


# Same flaw, pre-existing: the outputs file's .values() call assumed a JSON object without
# checking, so a valid JSON list raised AttributeError, which main()'s except tuple didn't
# catch.
def test_outputs_as_a_list_is_a_warning_not_a_failure(tmp_path):
    o = tmp_path / "outputs.json"
    o.write_text(json.dumps([]))
    r = run(tmp_path, {"a": "x"}, {"a": "x", "b": "y"}, "--outputs", str(o))
    assert r.returncode == 0
    assert "warning" in r.stderr
