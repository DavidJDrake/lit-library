import json
from pathlib import Path

import yaml

from ebook_indexer.cli import main
from ebook_indexer.config import load_config


def write_config(tmp_path, root) -> Path:
    cfg = tmp_path / "config.yaml"
    cfg.write_text(yaml.safe_dump({
        "library_root": str(root),
        "output_dir": "out",
        "metadata_dir": "metadata",
        "aws_region": "us-east-1",
        "books_bucket": "",
        "site_bucket": "",
        "cloudfront_distribution_id": "",
    }))
    return cfg


def test_load_config_resolves_relative_dirs(tmp_path):
    cfg = write_config(tmp_path, tmp_path / "lib")
    c = load_config(cfg)
    assert c.output_dir == tmp_path / "out"
    assert c.metadata_dir == tmp_path / "metadata"


def test_index_command_end_to_end(tmp_path, make_epub, capsys):
    root = tmp_path / "lib"
    make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "attacking_network_protocols.epub")
    cfg = write_config(tmp_path, root)
    rc = main(["index", "--config", str(cfg), "--skip-enrich"])
    assert rc == 0
    data = json.loads((tmp_path / "out" / "catalog.json").read_text())
    assert len(data["books"]) == 1
    assert "Indexed 1 books" in capsys.readouterr().out


def test_publish_requires_buckets(tmp_path, capsys):
    cfg = write_config(tmp_path, tmp_path / "lib")
    (tmp_path / "lib").mkdir()
    rc = main(["publish", "--config", str(cfg)])
    assert rc == 2
    assert "books_bucket and site_bucket" in capsys.readouterr().err
