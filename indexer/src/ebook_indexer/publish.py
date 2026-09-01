import json
import time
from pathlib import Path

from .models import ScannedFile


def _load_state(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def sync_books(s3, bucket: str, files: list[ScannedFile], state_path: Path) -> int:
    state = _load_state(state_path)
    uploaded = 0
    for f in files:
        key = f"books/{f.rel_path}"
        if state.get(key) == f.size:
            continue
        s3.upload_file(str(f.path), bucket, key,
                       ExtraArgs={"StorageClass": "INTELLIGENT_TIERING"})
        state[key] = f.size
        state_path.write_text(json.dumps(state, indent=0, sort_keys=True))
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
