import json
import subprocess
import sys
from pathlib import Path

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "pull-edits.py"

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


def test_warns_about_and_drops_comments_below_the_header(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    text = overrides.read_text()
    overrides.write_text(
        text.replace("bbbb:\n  year: 1999\n", "bbbb:\n  year: 1999\n  # pinned manually, don't touch\n")
    )
    before = overrides.read_text()

    dry = run_proc(cfg, scan_file, "--dry-run")
    assert overrides.read_text() == before  # dry-run changes nothing
    assert "warning: 1 comment line(s) below the header will be dropped" in dry.stderr
    assert "# pinned manually, don't touch" in dry.stderr

    real = run_proc(cfg, scan_file)
    assert "warning: 1 comment line(s) below the header will be dropped" in real.stderr
    assert "# pinned manually, don't touch" not in overrides.read_text()
