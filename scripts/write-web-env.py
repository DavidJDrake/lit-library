#!/usr/bin/env python3
"""Write web/.env.development.local and web/.env.production.local from CDK outputs.

Usage: scripts/write-web-env.py [infra/outputs.json] [web]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCAL_REDIRECT = "http://localhost:5173/"


def render(outputs: dict, redirect_uri: str) -> str:
    return (
        f"VITE_COGNITO_DOMAIN={outputs['CognitoDomain']}\n"
        f"VITE_CLIENT_ID={outputs['UserPoolClientId']}\n"
        f"VITE_API_URL={outputs['ApiUrl']}\n"
        f"VITE_REDIRECT_URI={redirect_uri}\n"
    )


def main(argv: list[str]) -> int:
    outputs_path = Path(argv[1]) if len(argv) > 1 else ROOT / "infra" / "outputs.json"
    web_dir = Path(argv[2]) if len(argv) > 2 else ROOT / "web"
    outputs = next(iter(json.loads(outputs_path.read_text()).values()))
    site_redirect = outputs["SiteUrl"].rstrip("/") + "/"
    (web_dir / ".env.development.local").write_text(render(outputs, LOCAL_REDIRECT))
    (web_dir / ".env.production.local").write_text(render(outputs, site_redirect))
    print(f"wrote {web_dir}/.env.development.local and .env.production.local")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
