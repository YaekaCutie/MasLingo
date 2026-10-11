"""Refuse endpoints that would turn the translation relay into an SSRF vector.

`/api/translate-text` in ``openai-compatible`` mode posts to a URL the caller
names. That is by design — the whole point is to reach whatever endpoint the
user configured, which is very often a backend on their own machine — so
private and loopback addresses stay allowed. What is *not* by design is
reaching cloud instance metadata: a request to 169.254.169.254 with a
controlled body and headers is the standard way to convert an open relay into
stolen credentials.

Two bypasses of the original IP-literal check are closed here and in
``openai_compatible``:

* a hostname that *resolves* to a blocked address used to be waved through
  untouched, because only literals were examined;
* ``urllib`` follows 3xx redirects by default, so an attacker-controlled
  endpoint could pass the initial check and then bounce the request to a
  blocked address. Every hop is validated in ``openai_compatible`` before it
  is followed.

A resolved-then-rebound hostname is not fully closed — this check and the
later connection resolve separately — but it turns a one-line bypass into a
race, which is the honest limit of validating by name.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def _blocked(address) -> bool:
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        return _blocked(mapped)
    return address.is_link_local or address.is_multicast or address.is_reserved


def assert_safe_endpoint(endpoint: str, *, resolve: bool = True) -> None:
    """Raise ValueError for an endpoint the relay must not be pointed at."""
    parsed = urlparse(endpoint or "")
    if parsed.scheme not in ("http", "https"):
        raise ValueError("接口地址必须是 http 或 https。")
    host = parsed.hostname or ""
    if not host:
        raise ValueError("接口地址缺少主机名。")

    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if _blocked(address):
            raise ValueError("不允许访问链路本地或保留地址。")
        return

    if not resolve:
        return
    try:
        answers = socket.getaddrinfo(host, None)
    except OSError as exc:
        raise ValueError("无法解析接口地址的主机名。") from exc
    for answer in answers:
        try:
            address = ipaddress.ip_address(str(answer[4][0]).split("%", 1)[0])
        except ValueError:
            continue
        if _blocked(address):
            raise ValueError("不允许访问链路本地或保留地址。")
