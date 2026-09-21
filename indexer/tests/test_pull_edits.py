import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "pull-edits.py"


def _load_module():
    """pull-edits.py has a hyphen in its name, so it can't be imported normally."""
    spec = importlib.util.spec_from_file_location("pull_edits", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pull_edits = _load_module()

HEADER = "# Manual metadata overrides. Keyed by book id.\n# Keep this comment.\n"


def s(v):
    return {"S": v}


def scan(items):
    return {"Items": items, "Count": len(items), "ScannedCount": len(items)}


def setup(tmp_path):
    meta = tmp_path / "metadata"
    out = tmp_path / "out"
    meta.mkdir()
    out.mkdir()
    (meta / "overrides.yaml").write_text(
        HEADER + "aaaa:\n  title: Keep Me\n  category: Fiction\nbbbb:\n  year: 1999\n"
    )
    (out / "catalog.json").write_text(json.dumps({"books": [{"id": "aaaa"}, {"id": "bbbb"}, {"id": "cccc"}]}))
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        f"library_root: {tmp_path}\noutput_dir: out\nmetadata_dir: metadata\n"
        "aws_region: us-east-1\nlibrary_table: lib\n"
    )
    scan_file = tmp_path / "scan.json"
    scan_file.write_text(json.dumps(scan([
        {"pk": s("CATEGORY"), "sk": s("Fiction"), "source": s("seed")},
        {"pk": s("CATEGORY"), "sk": s("Cookbooks"), "source": s("admin")},
        {"pk": s("CATEGORY"), "sk": s("Poetry"), "source": s("suggestion")},
        {"pk": s("BOOK"), "sk": s("aaaa"), "category": s("Cookbooks"), "changedBy": s("u@x"), "changedAt": s("t")},
        {"pk": s("BOOK"), "sk": s("cccc"), "category": s("Poetry"), "changedBy": s("u@x"), "changedAt": s("t")},
        {"pk": s("BOOK"), "sk": s("zzzz"), "category": s("Fiction"), "changedBy": s("u@x"), "changedAt": s("t")},
        {"pk": s("SUGGESTION"), "sk": s("s1"), "name": s("Essays"), "status": s("pending")},
    ])))
    return cfg, scan_file, meta / "overrides.yaml"


def run_proc(cfg, scan_file, *extra):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--config", str(cfg), "--input", str(scan_file), *extra],
        check=True, capture_output=True, text=True,
    )


def run(cfg, scan_file, *extra):
    return run_proc(cfg, scan_file, *extra).stdout


def test_merges_book_categories_and_site_categories_and_reports_orphans(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    out = run(cfg, scan_file)
    text = overrides.read_text()
    assert text.startswith(HEADER)
    data = yaml.safe_load(text)
    assert data["categories"] == ["Cookbooks", "Poetry"]  # built-ins excluded, sorted
    assert data["aaaa"] == {"title": "Keep Me", "category": "Cookbooks"}
    assert data["bbbb"] == {"year": 1999}  # untouched
    assert data["cccc"] == {"category": "Poetry"}
    assert data["zzzz"] == {"category": "Fiction"}  # written, but reported
    assert "merged 3 book categories, 2 site categories" in out
    assert "orphan: zzzz (Fiction)" in out
    assert "orphan: cccc" not in out


def test_dry_run_changes_nothing(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    before = overrides.read_text()
    out = run(cfg, scan_file, "--dry-run")
    assert overrides.read_text() == before
    assert "merged 3 book categories" in out


def test_is_idempotent(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    run(cfg, scan_file)
    once = overrides.read_text()
    run(cfg, scan_file)
    assert overrides.read_text() == once


def test_skips_a_book_item_missing_category_and_warns(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    scan_file.write_text(json.dumps(scan([
        {"pk": s("CATEGORY"), "sk": s("Fiction"), "source": s("seed")},
        {"pk": s("BOOK"), "sk": s("aaaa"), "category": s("Fiction"), "changedBy": s("u@x"), "changedAt": s("t")},
        {"pk": s("BOOK"), "sk": s("bbbb"), "changedBy": s("u@x"), "changedAt": s("t")},  # no category
    ])))
    proc = run_proc(cfg, scan_file)
    data = yaml.safe_load(overrides.read_text())
    assert data["aaaa"] == {"title": "Keep Me", "category": "Fiction"}
    assert data["bbbb"] == {"year": 1999}  # untouched: the malformed item was skipped
    assert "warning: BOOK bbbb has no category; skipped" in proc.stderr
    assert "merged 1 book categories, 0 site categories" in proc.stdout


def test_keeps_comments_order_and_untouched_entries(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    overrides.write_text(
        HEADER
        + "zzzz:\n  year: 1999\n"
        + "\n# --- A section note that must survive ---\n"
        + "aaaa:\n  title: Keep Me\n  category: Fiction\n"
        + "bbbb:\n  description: 'first line\n\n    after a blank line'\n  year: 1999\n"
    )
    run(cfg, scan_file)
    text = overrides.read_text()
    assert text.startswith(HEADER)
    assert "# --- A section note that must survive ---" in text
    assert text.index("zzzz:") < text.index("# --- A section note") < text.index("aaaa:") < text.index("bbbb:")
    assert "bbbb:\n  description: 'first line\n\n    after a blank line'\n  year: 1999\n" in text
    data = yaml.safe_load(text)
    assert data["aaaa"]["category"] == "Cookbooks"
    assert data["zzzz"]["category"] == "Fiction"


def test_folds_work_corrections_and_removes_stale_work_keys(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    overrides.write_text(HEADER + "aaaa:\n  title: Keep Me\n  work: old\nbbbb:\n  work: gone\n")
    items = json.loads(scan_file.read_text())["Items"] + [
        {"pk": s("WORKEDIT"), "sk": s("aaaa"), "workId": s("cccc"), "by": s("u@x"), "at": s("t")},
        {"pk": s("WORKEDIT"), "sk": s("dddd"), "workId": s("dddd"), "by": s("u@x"), "at": s("t")},
    ]
    scan_file.write_text(json.dumps(scan(items)))
    out = run(cfg, scan_file)
    data = yaml.safe_load(overrides.read_text())
    assert data["aaaa"]["work"] == "cccc"
    assert data["aaaa"]["title"] == "Keep Me"
    assert "bbbb" not in data
    assert data["dddd"] == {"work": "dddd"}
    assert "2 work corrections" in out


def test_unchanged_file_is_not_rewritten(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    run(cfg, scan_file)
    first = overrides.read_text()
    out = run(cfg, scan_file)
    assert overrides.read_text() == first
    assert "already up to date" in out


def test_rewrite_is_a_noop_for_an_unquoted_numeric_top_level_key():
    text = "aaaa:\n  year: 1\n1234567890123:\n  year: 2\nbbbb:\n  year: 3\n"
    # As main() does since the fix: normalise every key to str before calling rewrite.
    merged = {str(k): v for k, v in yaml.safe_load(text).items()}
    assert pull_edits.rewrite(text, merged) == text


def test_rewrite_changes_only_the_numeric_entry_in_place():
    text = "aaaa:\n  year: 1\n1234567890123:\n  year: 2\nbbbb:\n  year: 3\n"
    merged = {str(k): v for k, v in yaml.safe_load(text).items()}
    merged["1234567890123"] = {"year": 9}
    out = pull_edits.rewrite(text, merged)
    # The changed entry is re-rendered, and yaml.safe_dump quotes a digit-only string key
    # so a later read doesn't parse it back into an int (which would reintroduce the bug).
    assert out == "aaaa:\n  year: 1\n'1234567890123':\n  year: 9\nbbbb:\n  year: 3\n"
    assert out.index("aaaa:") < out.index("1234567890123") < out.index("bbbb:")
