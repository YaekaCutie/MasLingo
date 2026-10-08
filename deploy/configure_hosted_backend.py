"""Point the extension at a hosted backend and (optionally) repackage it.

After deploy/README.md has the server answering on https://<host>/health, this
is the only step needed to make new installs work with no local setup:

    python deploy/configure_hosted_backend.py https://ocr.example.com --pack extension.pem

It rewrites exactly two things:

  extension/config.js       globalThis.MAS_BACKEND_URL
  extension/manifest.json   the hosted entry in host_permissions

and leaves the localhost fallbacks alone, so an existing user who runs their
own backend keeps working. Running it again with a new host is safe.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_JS = REPO_ROOT / "extension" / "config.js"
MANIFEST = REPO_ROOT / "extension" / "manifest.json"
LOCAL_HOSTS = ["http://127.0.0.1:8001/*", "http://localhost:8001/*"]
CONFIG_PATTERN = re.compile(r'^(globalThis\.MAS_BACKEND_URL\s*=\s*)".*?"(;.*)$', re.MULTILINE)


def normalize(raw: str) -> str:
    url = raw.strip().rstrip("/")
    if not url.startswith(("https://", "http://")):
        sys.exit(f"backend url must start with https:// or http:// (got {raw!r})")
    if url.startswith("http://") and not re.match(r"^http://(127\.0\.0\.1|localhost)", url):
        print(f"warning: {url} is plain HTTP — screenshots would be sent unencrypted")
    return url


def update_config(url: str) -> str:
    source = CONFIG_JS.read_text(encoding="utf-8")
    updated, count = CONFIG_PATTERN.subn(lambda m: f'{m.group(1)}"{url}"{m.group(2)}', source)
    if count != 1:
        sys.exit(f"expected exactly one MAS_BACKEND_URL assignment in {CONFIG_JS}, found {count}")
    CONFIG_JS.write_text(updated, encoding="utf-8")
    return url


def update_manifest(url: str) -> list[str]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    host = re.sub(r"^(https?://[^/]+).*$", r"\1/*", url)
    hosts = list(LOCAL_HOSTS)
    if host not in hosts:
        hosts.append(host)
    manifest["host_permissions"] = hosts
    MANIFEST.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return hosts


def set_version(version: str) -> str:
    if not re.fullmatch(r"\d+(\.\d+){0,3}", version):
        sys.exit(f"version must be 1-4 dot-separated integers (got {version!r})")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest["version"] = version
    MANIFEST.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", help="hosted backend base URL, e.g. https://ocr.example.com")
    parser.add_argument("--pack", metavar="KEY_PEM", help="also rebuild the CRX/ZIP with this signing key")
    parser.add_argument("--outdir", default=str(REPO_ROOT), help="where to write the packages (default: repo root)")
    parser.add_argument("--version", help="also set the manifest version (must increase for every store upload)")
    args = parser.parse_args()

    url = normalize(args.url)
    update_config(url)
    hosts = update_manifest(url)
    if args.version:
        set_version(args.version)

    version = json.loads(MANIFEST.read_text(encoding="utf-8"))["version"]
    print(f"config.js   : MAS_BACKEND_URL = {url}")
    print(f"manifest    : host_permissions = {hosts}")
    print(f"version     : {version}")

    if args.pack:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from pack_extension import build_crx, build_zip  # noqa: PLC0415

        outdir = Path(args.outdir)
        outdir.mkdir(parents=True, exist_ok=True)
        zip_bytes = build_zip(REPO_ROOT / "extension")
        crx_bytes, extension_id = build_crx(zip_bytes, Path(args.pack))
        zip_path = outdir / f"MasLingo-{version}.zip"
        crx_path = outdir / f"MasLingo-{version}.crx"
        zip_path.write_bytes(zip_bytes)
        crx_path.write_bytes(crx_bytes)
        print(f"extension id: {extension_id}")
        print(f"wrote       : {zip_path}")
        print(f"wrote       : {crx_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
