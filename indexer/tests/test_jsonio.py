import json

from ebook_indexer.jsonio import read_json_or, write_json_atomic


def test_write_json_atomic_writes_no_leftover_tmp(tmp_path):
    path = tmp_path / "state.json"
    write_json_atomic(path, {"a": 1})
    assert json.loads(path.read_text()) == {"a": 1}
    assert not path.with_suffix(".json.tmp").exists()


def test_write_json_atomic_creates_parent_dirs(tmp_path):
    path = tmp_path / "nested" / "dir" / "state.json"
    write_json_atomic(path, {"a": 1})
    assert json.loads(path.read_text()) == {"a": 1}


def test_read_json_or_missing_file_returns_default(tmp_path):
    assert read_json_or(tmp_path / "nope.json", {}) == {}


def test_read_json_or_truncated_file_returns_default(tmp_path):
    path = tmp_path / "state.json"
    path.write_text('{"a": 1, "b"')  # truncated/corrupt JSON
    assert read_json_or(path, {}) == {}


def test_read_json_or_valid_file_returns_data(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"a": 1}))
    assert read_json_or(path, {}) == {"a": 1}
