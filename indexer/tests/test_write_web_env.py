import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "write-web-env.py"


def test_writes_both_env_files(tmp_path):
    outputs = tmp_path / "outputs.json"
    outputs.write_text(json.dumps({"EbookShare": {
        "CognitoDomain": "https://lit-x.auth.us-east-1.amazoncognito.com",
        "UserPoolClientId": "client123",
        "ApiUrl": "https://api.example.com",
        "SiteUrl": "https://lit.example.com",
    }}))
    web = tmp_path / "web"
    web.mkdir()
    subprocess.run([sys.executable, str(SCRIPT), str(outputs), str(web)], check=True)
    dev = (web / ".env.development.local").read_text()
    prod = (web / ".env.production.local").read_text()
    assert "VITE_CLIENT_ID=client123" in dev and "VITE_CLIENT_ID=client123" in prod
    assert "VITE_REDIRECT_URI=http://localhost:5173/" in dev
    assert "VITE_REDIRECT_URI=https://lit.example.com/" in prod
    assert "VITE_API_URL=https://api.example.com" in prod
