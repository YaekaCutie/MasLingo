"""Deterministic Chrome CRX3 packer.

Chrome's own "Pack extension" dialog needs a browser and a GUI; this does the
same job on a server or in CI so a release can be reproduced from the tag.

Usage:
    python deploy/pack_extension.py extension extension.pem MasLingo.crx

Writes the .crx and a sibling .zip (the ZIP is what the Chrome Web Store
wants; the CRX is for self-distribution).
"""

from __future__ import annotations

import hashlib
import io
import struct
import sys
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

# Fixed timestamp keeps rebuilds byte-identical.
FIXED_DATE = (1980, 1, 1, 0, 0, 0)
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append((byte | 0x80) if value else byte)
        if not value:
            return bytes(out)


def _bytes_field(field: int, value: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(value)) + value


def build_zip(extension_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(p for p in extension_dir.rglob("*") if p.is_file()):
            if path.name in SKIP_NAMES:
                continue
            info = zipfile.ZipInfo(path.relative_to(extension_dir).as_posix(), date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    return buffer.getvalue()


def extension_id(public_der: bytes) -> str:
    digest = hashlib.sha256(public_der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(character, 16)) for character in digest)


def build_crx(zip_bytes: bytes, key_path: Path) -> tuple[bytes, str]:
    key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    public_der = key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    crx_id = bytes.fromhex(hashlib.sha256(public_der).hexdigest()[:32])
    signed_header_data = _bytes_field(1, crx_id)
    payload = (
        b"CRX3 SignedData\x00"
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + zip_bytes
    )
    signature = key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
    proof = _bytes_field(1, public_der) + _bytes_field(2, signature)
    header = _bytes_field(2, proof) + _bytes_field(10000, signed_header_data)
    return b"Cr24" + struct.pack("<II", 3, len(header)) + header + zip_bytes, extension_id(public_der)


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    extension_dir, key_path, output = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    if not (extension_dir / "manifest.json").is_file():
        sys.exit(f"no manifest.json in {extension_dir}")

    zip_bytes = build_zip(extension_dir)
    crx_bytes, identifier = build_crx(zip_bytes, key_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(crx_bytes)
    zip_output = output.with_suffix(".zip")
    zip_output.write_bytes(zip_bytes)

    print(f"extension id : {identifier}")
    print(f"zip          : {zip_output} ({len(zip_bytes)} bytes, sha256={hashlib.sha256(zip_bytes).hexdigest()})")
    print(f"crx          : {output} ({len(crx_bytes)} bytes, sha256={hashlib.sha256(crx_bytes).hexdigest()})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
