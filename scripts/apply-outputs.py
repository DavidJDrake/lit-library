#!/usr/bin/env python3
"""Copy CDK stack outputs into config.yaml so the indexer can publish.

Usage: scripts/apply-outputs.py [infra/outputs.json] [config.yaml]
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEY_MAP = {
    "books_bucket": "BooksBucketName",
    "site_bucket": "SiteBucketName",
    "cloudfront_distribution_id": "DistributionId",
    "library_table": "LibraryTable",
}
OPTIONAL_KEYS = {"library_table"}  # tolerated when the stack output doesn't exist yet


def main(argv: list[str]) -> int:
    outputs_path = Path(argv[1]) if len(argv) > 1 else ROOT / "infra" / "outputs.json"
    config_path = Path(argv[2]) if len(argv) > 2 else ROOT / "config.yaml"
    stacks = json.loads(outputs_path.read_text())
    outputs = next(iter(stacks.values()))  # single stack: EbookShare
    text = config_path.read_text()
    for yaml_key, output_name in KEY_MAP.items():
        value = outputs.get(output_name)
        if value is None:
            if yaml_key in OPTIONAL_KEYS:
                continue  # this stack output does not exist yet
            print(f"outputs.json has no '{output_name}' output", file=sys.stderr)
            return 1
        pattern = re.compile(rf'^({yaml_key}:)[ \t]*(?:"[^"]*"|\'[^\']*\'|[^#\n]*?)[ \t]*(#.*)?$', re.MULTILINE)
        if not pattern.search(text):
            if not text.endswith("\n"):
                text += "\n"
            text += f'{yaml_key}: "{value}"\n'
            continue
        def repl(m):
            comment = f"  {m.group(2)}" if m.group(2) else ""
            return f'{m.group(1)} "{value}"{comment}'
        text = pattern.sub(repl, text)
    config_path.write_text(text)
    print(f"updated {config_path} from {outputs_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
