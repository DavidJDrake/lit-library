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


def test_index_seeds_overrides_stub_when_missing(tmp_path, make_epub):
    root = tmp_path / "lib"
    make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "attacking_network_protocols.epub")
    cfg = write_config(tmp_path, root)
    rc = main(["index", "--config", str(cfg), "--skip-enrich"])
    assert rc == 0
    overrides_path = tmp_path / "metadata" / "overrides.yaml"
    assert overrides_path.exists()
    assert "Manual metadata overrides" in overrides_path.read_text()


def test_index_does_not_overwrite_existing_overrides(tmp_path, make_epub):
    root = tmp_path / "lib"
    make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "attacking_network_protocols.epub")
    cfg = write_config(tmp_path, root)
    overrides_path = tmp_path / "metadata" / "overrides.yaml"
    overrides_path.parent.mkdir(parents=True)
    overrides_path.write_text("abc123:\n  category: Fiction\n")
    rc = main(["index", "--config", str(cfg), "--skip-enrich"])
    assert rc == 0
    assert overrides_path.read_text() == "abc123:\n  category: Fiction\n"


def test_publish_requires_buckets(tmp_path, capsys):
    cfg = write_config(tmp_path, tmp_path / "lib")
    (tmp_path / "lib").mkdir()
    rc = main(["publish", "--config", str(cfg)])
    assert rc == 2
    assert "books_bucket and site_bucket" in capsys.readouterr().err


def test_retry_failed_enrichment_clears_only_failed_cache_entries(tmp_path, make_epub, capsys):
    # This test must stay offline. The book's own enrichment cache entry is
    # pre-seeded as a hit (keyed by its ISBN, as Enricher._cached_lookup
    # does) so indexing never needs to make a real network call; only the
    # unrelated pre-seeded "failed" entry should be cleared by the flag.
    import hashlib
    import json

    root = tmp_path / "lib"
    make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "book.epub", isbn="9781593277505")
    cfg = write_config(tmp_path, root)

    cache_dir = tmp_path / "metadata" / "cache"
    cache_dir.mkdir(parents=True)
    hit_file = cache_dir / (hashlib.sha1(b"9781593277505").hexdigest() + ".json")
    hit_file.write_text(json.dumps({"found": True, "title": "Cached Title"}))
    miss_file = cache_dir / (hashlib.sha1(b"some-other-unresolved-book").hexdigest() + ".json")
    miss_file.write_text(json.dumps({"found": False}))

    rc = main(["index", "--config", str(cfg), "--retry-failed-enrichment"])

    assert rc == 0
    assert "Cleared 1 failed enrichment cache entries for retry" in capsys.readouterr().out
    assert hit_file.exists()  # successful lookups are left untouched
    assert not miss_file.exists()  # failed lookup cleared for retry


def test_google_books_api_key_env_var_is_forwarded_to_enricher(tmp_path, make_epub, monkeypatch):
    # Stays offline: spies on the Enricher constructor instead of letting
    # any real Enricher (and therefore any real network call) run.
    import ebook_indexer.cli as cli_module

    root = tmp_path / "lib"
    make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "book.epub")
    cfg = write_config(tmp_path, root)

    captured = {}

    class SpyEnricher:
        def __init__(self, cache_dir, **kwargs):
            captured.update(kwargs)

        def enrich(self, meta, fallback_title):
            pass

        def clear_failed_cache(self):
            return 0

    monkeypatch.setattr(cli_module, "Enricher", SpyEnricher)
    monkeypatch.setenv("GOOGLE_BOOKS_API_KEY", "env-key-456")

    rc = main(["index", "--config", str(cfg)])

    assert rc == 0
    assert captured.get("google_books_api_key") == "env-key-456"


def test_missing_api_key_env_var_passes_none(tmp_path, make_epub, monkeypatch):
    import ebook_indexer.cli as cli_module

    root = tmp_path / "lib"
    make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "book.epub")
    cfg = write_config(tmp_path, root)

    captured = {}

    class SpyEnricher:
        def __init__(self, cache_dir, **kwargs):
            captured.update(kwargs)

        def enrich(self, meta, fallback_title):
            pass

        def clear_failed_cache(self):
            return 0

    monkeypatch.setattr(cli_module, "Enricher", SpyEnricher)
    monkeypatch.delenv("GOOGLE_BOOKS_API_KEY", raising=False)

    rc = main(["index", "--config", str(cfg)])

    assert rc == 0
    assert captured.get("google_books_api_key") is None
