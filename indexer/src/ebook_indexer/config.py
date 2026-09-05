from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class Config:
    library_root: Path
    output_dir: Path
    metadata_dir: Path
    aws_region: str
    books_bucket: str
    site_bucket: str
    cloudfront_distribution_id: str
    library_table: str


def load_config(path: Path) -> Config:
    raw = yaml.safe_load(path.read_text())
    base = path.resolve().parent

    def _dir(key: str) -> Path:
        p = Path(raw[key])
        return p if p.is_absolute() else base / p

    return Config(
        library_root=Path(raw["library_root"]),
        output_dir=_dir("output_dir"),
        metadata_dir=_dir("metadata_dir"),
        aws_region=raw.get("aws_region", "us-east-1"),
        books_bucket=raw.get("books_bucket") or "",
        site_bucket=raw.get("site_bucket") or "",
        cloudfront_distribution_id=raw.get("cloudfront_distribution_id") or "",
        library_table=raw.get("library_table") or "",
    )
