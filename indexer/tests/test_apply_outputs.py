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
        "LibraryTable": "lib-789",
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
    assert data["library_table"] == "lib-789"          # appended because the line was missing
    assert config.read_text().rstrip().endswith('library_table: "lib-789"')


def test_apply_outputs_preserves_trailing_comments(tmp_path):
    outputs = tmp_path / "outputs.json"
    outputs.write_text(json.dumps({"EbookShare": {
        "SiteBucketName": "site-789", "BooksBucketName": "books-999",
        "DistributionId": "DISTRO123",
    }}))
    config = tmp_path / "config.yaml"
    config.write_text(
        "library_root: /lib\n"
        "books_bucket: \"\"           # filled in after Plan 2 (infra) deploys\n"
        "site_bucket: \"\"   # sync with apply-outputs.py\n"
        "cloudfront_distribution_id: \"\"  # from CDK outputs\n"
    )
    subprocess.run([sys.executable, str(SCRIPT), str(outputs), str(config)], check=True)
    content = config.read_text()
    # (a) Verify the values are rewritten
    data = yaml.safe_load(content)
    assert data["books_bucket"] == "books-999"
    assert data["site_bucket"] == "site-789"
    assert data["cloudfront_distribution_id"] == "DISTRO123"
    # (b) Verify the trailing comments are still present
    assert "# filled in after Plan 2 (infra) deploys" in content
    assert "# sync with apply-outputs.py" in content
    assert "# from CDK outputs" in content
    # (c) Verify yaml.safe_load still parses correctly (already checked above)


def test_apply_outputs_rewrites_an_existing_library_table_line(tmp_path):
    outputs = tmp_path / "outputs.json"
    outputs.write_text(json.dumps({"EbookShare": {
        "SiteBucketName": "s", "BooksBucketName": "b", "DistributionId": "d", "LibraryTable": "lib-new",
    }}))
    config = tmp_path / "config.yaml"
    config.write_text(
        "library_root: /lib\noutput_dir: out\nmetadata_dir: metadata\naws_region: us-east-1\n"
        "books_bucket: \"\"\nsite_bucket: \"\"\ncloudfront_distribution_id: \"\"\n"
        "library_table: \"lib-old\"   # category overlay table\n"
    )
    subprocess.run([sys.executable, str(SCRIPT), str(outputs), str(config)], check=True)
    text = config.read_text()
    assert 'library_table: "lib-new"  # category overlay table' in text
    assert text.count("library_table:") == 1
