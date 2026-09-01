import json
import subprocess
import sys
from pathlib import Path

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "apply-outputs.py"


def test_apply_outputs_rewrites_only_the_aws_keys(tmp_path):
    outputs = tmp_path / "outputs.json"
    outputs.write_text(json.dumps({"EbookShare": {
        "SiteBucketName": "site-123", "BooksBucketName": "books-456",
        "DistributionId": "E1ABC", "ApiUrl": "https://x.execute-api.us-east-1.amazonaws.com",
    }}))
    config = tmp_path / "config.yaml"
    config.write_text(
        "library_root: /lib\noutput_dir: out\nmetadata_dir: metadata\n"
        "aws_region: us-east-1\nbooks_bucket: \"\"\nsite_bucket: \"\"\n"
        "cloudfront_distribution_id: \"\"\n"
    )
    subprocess.run([sys.executable, str(SCRIPT), str(outputs), str(config)], check=True)
    data = yaml.safe_load(config.read_text())
    assert data["books_bucket"] == "books-456"
    assert data["site_bucket"] == "site-123"
    assert data["cloudfront_distribution_id"] == "E1ABC"
    assert data["library_root"] == "/lib"  # untouched
    assert data["aws_region"] == "us-east-1"
