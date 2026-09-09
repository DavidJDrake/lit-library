import time
from pathlib import Path

from .jsonio import read_json_or, write_json_atomic
from .models import ScannedFile


def sync_books(s3, bucket: str, files: list[ScannedFile], state_path: Path) -> int:
    state = read_json_or(state_path, {})
    uploaded = 0
    for f in files:
        key = f"books/{f.rel_path}"
        if state.get(key) == f.size:
            continue
        s3.upload_file(str(f.path), bucket, key,
                       ExtraArgs={"StorageClass": "INTELLIGENT_TIERING"})
        state[key] = f.size
        write_json_atomic(state_path, state)
        uploaded += 1
    return uploaded


def publish_site(s3, bucket: str, out_dir: Path) -> int:
    count = 0
    catalog = out_dir / "catalog.json"
    if catalog.exists():
        s3.put_object(Bucket=bucket, Key="catalog.json",
                      Body=catalog.read_bytes(),
                      ContentType="application/json", CacheControl="no-cache")
        count += 1
    for cover in sorted((out_dir / "covers").glob("*.webp")):
        s3.put_object(Bucket=bucket, Key=f"covers/{cover.name}",
                      Body=cover.read_bytes(),
                      ContentType="image/webp",
                      CacheControl="public, max-age=31536000")
        count += 1
    return count


def invalidate_catalog(cf, distribution_id: str) -> None:
    if not distribution_id:
        return
    cf.create_invalidation(
        DistributionId=distribution_id,
        InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": ["/catalog.json"]},
            "CallerReference": str(time.time()),
        },
    )


def find_orphan_books(s3, bucket: str, files: list[ScannedFile]) -> list[str]:
    """Keys under books/ in the bucket that no longer correspond to a scanned file.

    Books are uploaded but never deleted, so removing a file from the library takes
    it out of the catalog while leaving the object behind: unreachable through the
    site, since download links are only minted for catalogued books, but still
    stored and still paid for.

    Only keys under the books/ prefix are ever considered. The caller decides what
    to do with the result; this function reads and returns, it does not delete.
    """
    expected = {f"books/{f.rel_path}" for f in files}
    orphans = []
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": "books/"}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        for obj in page.get("Contents") or []:
            if obj["Key"] not in expected:
                orphans.append(obj["Key"])
        if not page.get("IsTruncated"):
            break
        token = page.get("NextContinuationToken")
    return sorted(orphans)


def delete_book_objects(s3, bucket: str, keys: list[str], state_path: Path) -> int:
    """Delete the given keys and forget them in the upload state.

    Refuses any key outside books/, so a bad caller cannot reach the catalogue,
    the covers, or the site bundle through this path.
    """
    outside = [k for k in keys if not k.startswith("books/")]
    if outside:
        raise ValueError(f"refusing to delete keys outside books/: {outside[:3]}")
    state = read_json_or(state_path, {})
    for key in keys:
        s3.delete_object(Bucket=bucket, Key=key)
        state.pop(key, None)
    write_json_atomic(state_path, state)
    return len(keys)
