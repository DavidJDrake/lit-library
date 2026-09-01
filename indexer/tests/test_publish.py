import json
from pathlib import Path

from ebook_indexer.models import ScannedFile
from ebook_indexer.publish import invalidate_catalog, publish_site, sync_books


class FakeS3:
    def __init__(self):
        self.uploads = []
        self.puts = []

    def upload_file(self, Filename, Bucket, Key, ExtraArgs=None):
        self.uploads.append((Filename, Bucket, Key, ExtraArgs))

    def put_object(self, **kwargs):
        self.puts.append(kwargs)


class FakeCloudFront:
    def __init__(self):
        self.invalidations = []

    def create_invalidation(self, DistributionId, InvalidationBatch):
        self.invalidations.append((DistributionId, InvalidationBatch))


def sf(tmp_path, rel: str, content: bytes) -> ScannedFile:
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    return ScannedFile(path=p, rel_path=rel, bundle=rel.split("/", 1)[0],
                       format="epub", size=len(content))


def test_sync_uploads_new_and_changed_only(tmp_path):
    s3 = FakeS3()
    state = tmp_path / "state.json"
    files = [sf(tmp_path, "B/EPUB/a.epub", b"aaaa"), sf(tmp_path, "B/EPUB/b.epub", b"bb")]
    assert sync_books(s3, "bkt", files, state) == 2
    assert s3.uploads[0][2] == "books/B/EPUB/a.epub"
    assert s3.uploads[0][3] == {"StorageClass": "INTELLIGENT_TIERING"}
    # second run: nothing changed
    assert sync_books(FakeS3(), "bkt", files, state) == 0
    # size change triggers re-upload
    files[0].path.write_bytes(b"aaaaaa")
    changed = [sf(tmp_path, "B/EPUB/a.epub", b"aaaaaa"), files[1]]
    s3b = FakeS3()
    assert sync_books(s3b, "bkt", changed, state) == 1
    assert json.loads(state.read_text())["books/B/EPUB/a.epub"] == 6


def test_publish_site_uploads_catalog_and_covers(tmp_path):
    out = tmp_path / "out"
    (out / "covers").mkdir(parents=True)
    (out / "catalog.json").write_text("{}")
    (out / "covers" / "abc.webp").write_bytes(b"w")
    s3 = FakeS3()
    assert publish_site(s3, "site", out) == 2
    keys = {p["Key"]: p for p in s3.puts}
    assert keys["catalog.json"]["ContentType"] == "application/json"
    assert keys["catalog.json"]["CacheControl"] == "no-cache"
    assert keys["covers/abc.webp"]["ContentType"] == "image/webp"


def test_invalidate_catalog_noop_without_distribution():
    cf = FakeCloudFront()
    invalidate_catalog(cf, "")
    assert cf.invalidations == []
    invalidate_catalog(cf, "DIST123")
    dist_id, batch = cf.invalidations[0]
    assert dist_id == "DIST123"
    assert batch["Paths"]["Items"] == ["/catalog.json"]
