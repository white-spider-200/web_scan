#!/usr/bin/env python3
"""
URL canonicalization + dedupe helpers.

This module is intentionally stricter than recon.url_classify.normalize_url:
- forces http/https URLs only
- lowercases host, strips default ports
- collapses duplicate slashes and dot-segments
- strips fragments
- normalizes query (optional tracking-param removal + stable sorting)

It also provides a "pattern key" (shape) to throttle infinite-growth URLs like
`/item/123`, `/item/124`, or `?id=1`, `?id=2`.
"""

import posixpath
import re
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple
from urllib.parse import (
    parse_qsl,
    quote,
    unquote,
    urlencode,
    urljoin,
    urlsplit,
    urlunsplit,
)

_IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)
_INT_RE = re.compile(r"^\d+$")
_HEX_RE = re.compile(r"^[0-9a-f]{16,}$", re.I)

# Common tracking/noise query params.
_TRACKING_KEYS = {
    "fbclid",
    "gclid",
    "igshid",
    "mc_cid",
    "mc_eid",
    "msclkid",
    "ref",
    "ref_src",
    "spm",
    "utm_campaign",
    "utm_content",
    "utm_medium",
    "utm_name",
    "utm_source",
    "utm_term",
}


def is_ip_hostname(hostname: str) -> bool:
    if not hostname:
        return False
    host = hostname.strip().lower()
    if _IPV4_RE.match(host):
        return True
    return False


@dataclass(frozen=True)
class CanonicalUrl:
    url: str
    scheme: str
    host: str
    path: str
    query: str


def _normalize_path(path: str) -> str:
    raw = path or "/"
    raw = re.sub(r"/{2,}", "/", raw)
    try:
        normalized = posixpath.normpath(raw)
    except Exception:
        normalized = raw
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    if normalized == "/.":
        normalized = "/"
    if normalized != "/" and normalized.endswith("/"):
        normalized = normalized.rstrip("/")
    # normalize percent-encoding for unreserved characters
    try:
        decoded = unquote(normalized)
        normalized = quote(decoded, safe="/:@-._~!$&'()*+,;=")
    except Exception:
        pass
    return normalized or "/"


def _filter_and_sort_query_pairs(pairs: Sequence[Tuple[str, str]], remove_tracking: bool) -> List[Tuple[str, str]]:
    filtered: List[Tuple[str, str]] = []
    for k, v in pairs:
        key = (k or "").strip()
        if not key:
            continue
        low = key.lower()
        if remove_tracking and (low in _TRACKING_KEYS or low.startswith("utm_")):
            continue
        filtered.append((key, v or ""))
    filtered.sort(key=lambda kv: (kv[0].lower(), kv[1]))
    return filtered


def canonicalize_url(raw: str, base: Optional[str] = None, *, remove_tracking: bool = True) -> Optional[CanonicalUrl]:
    if not raw:
        return None
    value = str(raw).strip()
    if not value:
        return None
    # remove fragments early to reduce parse variability
    value = re.sub(r"#.*$", "", value)

    try:
        if base:
            value = urljoin(base, value)
    except Exception:
        pass

    if value.startswith("//"):
        base_scheme = ""
        if base:
            try:
                base_scheme = urlsplit(base).scheme
            except Exception:
                base_scheme = ""
        value = f"{base_scheme or 'http'}:{value}"

    parts = None
    try:
        parts = urlsplit(value)
    except Exception:
        parts = None

    # handle schemeless inputs like "example.com/path"
    if not parts or not parts.scheme or not parts.netloc:
        assumed = "http"
        if base:
            try:
                assumed = urlsplit(base).scheme or "http"
            except Exception:
                assumed = "http"
        try:
            parts = urlsplit(f"{assumed}://{value}")
        except Exception:
            return None

    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https"):
        return None

    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        return None

    port = parts.port
    if port and ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        port = None
    netloc = host if not port else f"{host}:{port}"

    path = _normalize_path(parts.path or "/")

    query_pairs = parse_qsl(parts.query or "", keep_blank_values=True)
    normalized_pairs = _filter_and_sort_query_pairs(query_pairs, remove_tracking=remove_tracking)
    query = urlencode(normalized_pairs, doseq=True)

    url = urlunsplit((scheme, netloc, path, query, ""))
    return CanonicalUrl(url=url, scheme=scheme, host=netloc, path=path, query=query)


def canonical_url(raw: str, base: Optional[str] = None, *, remove_tracking: bool = True) -> str:
    parsed = canonicalize_url(raw, base, remove_tracking=remove_tracking)
    return parsed.url if parsed else ""


def _normalize_value_token(value: str) -> str:
    if value is None:
        return ""
    v = str(value)
    if not v:
        return ""
    if _INT_RE.match(v):
        return "{int}"
    if _UUID_RE.match(v):
        return "{uuid}"
    if _HEX_RE.match(v):
        return "{hex}"
    if len(v) > 64:
        return "{long}"
    return "{str}"


def _normalize_path_segment(seg: str) -> str:
    if seg is None:
        return ""
    s = str(seg).strip()
    if not s:
        return ""
    if _INT_RE.match(s):
        return "{int}"
    if _UUID_RE.match(s):
        return "{uuid}"
    if _HEX_RE.match(s):
        return "{hex}"
    if len(s) > 64:
        return "{long}"
    return s


def url_pattern_key(url: str) -> str:
    """
    Return a stable "shape" key for throttling similar URLs.

    - Path dynamic tokens become placeholders
    - Query values become placeholders (keys preserved)
    """
    try:
        parts = urlsplit(url)
    except Exception:
        return url
    host = (parts.hostname or "").lower()
    if not host:
        return url
    path = unquote(parts.path or "/")
    path = re.sub(r"/{2,}", "/", path)
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    segs = [s for s in path.split("/") if s]
    norm_segs = [_normalize_path_segment(s) for s in segs]
    norm_path = "/" + "/".join([s for s in norm_segs if s]) if norm_segs else "/"

    q = parse_qsl(parts.query or "", keep_blank_values=True)
    q_norm = []
    for k, v in q:
        key = (k or "").strip().lower()
        if not key:
            continue
        q_norm.append((key, _normalize_value_token(v)))
    q_norm.sort()
    if q_norm:
        q_part = "&".join([f"{k}={v}" for k, v in q_norm])
        return f"{host}{norm_path}?{q_part}"
    return f"{host}{norm_path}"


def query_param_count(url: str) -> int:
    try:
        parts = urlsplit(url)
    except Exception:
        return 0
    try:
        pairs = parse_qsl(parts.query or "", keep_blank_values=True)
    except Exception:
        return 0
    return len(pairs)
