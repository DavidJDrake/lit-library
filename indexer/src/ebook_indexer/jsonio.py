import json
import os
from pathlib import Path
from typing import Any


def write_json_atomic(path: Path, data: Any) -> None:
    """Write JSON to path atomically: write to a temp file, then os.replace.

    Guards against an interrupted write leaving a truncated/corrupt file
    behind, since os.replace is atomic on POSIX and Windows.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, indent=0, sort_keys=True))
    os.replace(tmp_path, path)


def read_json_or(path: Path, default: Any) -> Any:
    """Read JSON from path, returning default if missing, truncated, or unreadable."""
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default
