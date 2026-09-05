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


def run(cfg, scan_file, *extra):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--config", str(cfg), "--input", str(scan_file), *extra],
        check=True, capture_output=True, text=True,
    ).stdout


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
