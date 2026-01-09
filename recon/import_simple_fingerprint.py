#!/usr/bin/env python3
"""
import_simple_fingerprint.py <website_url> <simple_fingerprint_json>

Updates the normalized DB graph (server/data.db) with host-level fingerprint metadata:
- nodes: status/size/ip/response_time_ms/title/wappalyzer/tls_cert/details
- node_headers: HTTP response headers
- node_technologies: detected technologies (heuristics + wappalyzer when available)

Also ensures the host node exists and is linked under the root website domain via a
'contains' relationship (domain -> subdomain).
"""

import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "server" / "data.db"

_IPV4_RE = re.compile(r"^\\d{1,3}(?:\\.\\d{1,3}){3}$")


def get_host(url_or_host: str) -> str:
    s = (url_or_host or "").strip()
    if not s:
        return ""
    try:
        p = urlparse(s if "://" in s else f"http://{s}")
        if p.hostname:
            host = p.hostname.lower()
            port = p.port
            if port in (80, 443):
                port = None
            return f"{host}:{port}" if port else host
    except Exception:
        pass
    s = re.sub(r"^https?://", "", s, flags=re.I)
    return (s.split("/")[0]).lower()


def is_in_scope(host: str, root: str) -> bool:
    def strip_port(v: str) -> str:
        v = (v or "").strip().lower()
        if not v:
            return ""
        if _IPV4_RE.match(v):
            return v
        if ":" in v:
            return v.split(":", 1)[0]
        return v

    host_base = strip_port(host)
    root_base = strip_port(root)
    if not host_base or not root_base:
        return False
    if _IPV4_RE.match(root_base):
        return host_base == root_base
    if host_base == root_base:
        return True
    return host_base.endswith("." + root_base)


def ensure_website(db, website_url: str) -> int:
    cur = db.cursor()
    cur.execute("INSERT OR IGNORE INTO websites (url, name) VALUES (?, ?)", (website_url, website_url))
    cur.execute("SELECT id FROM websites WHERE url = ? LIMIT 1", (website_url,))
    row = cur.fetchone()
    return row[0] if row else None


def get_node_id_by_value(db, website_id: int, value: str):
    cur = db.cursor()
    cur.execute("SELECT id FROM nodes WHERE website_id = ? AND value = ? LIMIT 1", (website_id, value))
    row = cur.fetchone()
    return row[0] if row else None


def choose_type(existing_type: str, incoming_type: str) -> str:
    a = (existing_type or "").lower()
    b = (incoming_type or "").lower()
    if not a:
        return incoming_type
    if not b:
        return existing_type
    ranks = {
        "domain": 50,
        "subdomain": 45,
        "ip": 40,
        "endpoint": 30,
        "path": 30,
        "file": 30,
        "directory": 20,
        "dir": 20,
        "unknown": 0,
    }
    ra = ranks.get(a, 10)
    rb = ranks.get(b, 10)
    return incoming_type if rb > ra else existing_type


def upsert_node(db, website_id: int, value: str, ntype: str) -> int:
    try:
        db.execute("INSERT OR IGNORE INTO nodes (website_id, value, type) VALUES (?, ?, ?)", (website_id, value, ntype))
    except Exception:
        pass
    cur = db.cursor()
    cur.execute("SELECT id, type FROM nodes WHERE website_id = ? AND value = ? LIMIT 1", (website_id, value))
    row = cur.fetchone()
    if row:
        node_id = row[0]
        existing_type = row[1]
        chosen = choose_type(existing_type, ntype)
        try:
            db.execute("UPDATE nodes SET type = ? WHERE id = ?", (chosen, node_id))
        except Exception:
            pass
        return node_id
    cur.execute("INSERT INTO nodes (website_id, value, type) VALUES (?, ?, ?)", (website_id, value, ntype))
    return cur.lastrowid


def insert_rel(db, src_id: int, tgt_id: int, rtype: str = "contains"):
    try:
        db.execute(
            "INSERT OR IGNORE INTO node_relationships (source_node_id, target_node_id, relationship_type) VALUES (?, ?, ?)",
            (src_id, tgt_id, rtype),
        )
    except Exception:
        pass


def detect_columns(db, table: str):
    try:
        rows = db.execute(f"PRAGMA table_info('{table}')").fetchall()
        return [r[1] for r in rows]
    except Exception:
        return []


def merge_details(db, node_id: int, patch: dict):
    if not patch:
        return
    cur = db.cursor()
    cur.execute("SELECT details FROM nodes WHERE id = ? LIMIT 1", (node_id,))
    row = cur.fetchone()
    existing = {}
    if row and row[0]:
        try:
            existing = json.loads(row[0]) if isinstance(row[0], str) else dict(row[0])
        except Exception:
            existing = {}
    existing.update({k: v for k, v in (patch or {}).items() if v is not None})
    try:
        cur.execute("UPDATE nodes SET details = ? WHERE id = ?", (json.dumps(existing), node_id))
    except Exception:
        pass


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 import_simple_fingerprint.py <website_url> <simple_fingerprint_json>")
        sys.exit(1)

    website_url = sys.argv[1].strip()
    json_path = Path(sys.argv[2])
    if not json_path.exists():
        print(f"ERROR: JSON file not found: {json_path}")
        sys.exit(2)

    raw = json.loads(json_path.read_text(encoding="utf-8", errors="replace"))
    target = raw.get("target") if isinstance(raw, dict) else None
    probe = None
    probes = raw.get("probes") if isinstance(raw, dict) else None
    if isinstance(probes, list) and probes:
        probe = probes[0] if isinstance(probes[0], dict) else None

    host = get_host(target or "") or get_host(website_url)
    root = get_host(website_url) or host
    if not host:
        print("ERROR: could not determine host from fingerprint JSON")
        sys.exit(3)
    if not is_in_scope(host, root):
        print(f"ERROR: host {host} is out of scope for website {root}")
        sys.exit(4)

    db = sqlite3.connect(str(DB_PATH), timeout=30)
    try:
        db.execute("PRAGMA busy_timeout = 5000")
    except Exception:
        pass
    try:
        website_id = ensure_website(db, website_url)
        root_id = upsert_node(db, website_id, root, "domain")
        host_id = upsert_node(db, website_id, host, "domain" if host == root else "subdomain")
        if host != root:
            insert_rel(db, root_id, host_id, "contains")

        updates = {}
        headers = {}
        techs = set()
        details = {
            "fingerprint_source": str(json_path.name),
        }

        if isinstance(probe, dict):
            if probe.get("status_code") is not None:
                updates["status"] = probe.get("status_code")
            if probe.get("content_length") is not None:
                updates["size"] = probe.get("content_length")
            if probe.get("resolved_ip"):
                updates["ip"] = str(probe.get("resolved_ip"))
            if probe.get("response_time_ms") is not None:
                updates["response_time_ms"] = probe.get("response_time_ms")
            if probe.get("title"):
                updates["title"] = str(probe.get("title"))

            if isinstance(probe.get("headers"), dict):
                headers = {str(k): str(v) for k, v in probe.get("headers").items()}

            if isinstance(probe.get("tech"), list):
                techs.update([str(t) for t in probe.get("tech") if t])

            wapp = probe.get("wappalyzer")
            if wapp is not None:
                try:
                    updates["wappalyzer"] = json.dumps(wapp)
                except Exception:
                    updates["wappalyzer"] = str(wapp)
                if isinstance(wapp, dict) and isinstance(wapp.get("technologies"), (list, set, tuple)):
                    techs.update([str(t) for t in wapp.get("technologies") if t])

            tls = probe.get("tls_cert")
            if tls is not None:
                try:
                    updates["tls_cert"] = json.dumps(tls)
                except Exception:
                    updates["tls_cert"] = str(tls)

            details.update(
                {
                    "url": probe.get("url"),
                    "ok": probe.get("ok"),
                    "error": probe.get("error"),
                    "redirects": probe.get("redirects"),
                    "server_banner": probe.get("server_banner"),
                    "banner_probe": probe.get("banner_probe"),
                }
            )

        # Update node row
        if updates:
            sets = ", ".join([f"{k} = ?" for k in updates.keys()])
            params = list(updates.values()) + [host_id]
            try:
                db.execute(f"UPDATE nodes SET {sets} WHERE id = ?", params)
            except Exception as e:
                print(f"WARNING: failed to update nodes row: {e}")

        # Update headers table
        header_cols = detect_columns(db, "node_headers")
        key_col = "header_key" if "header_key" in header_cols else ("name" if "name" in header_cols else None)
        val_col = "header_value" if "header_value" in header_cols else ("value" if "value" in header_cols else None)
        if key_col and val_col:
            try:
                db.execute("DELETE FROM node_headers WHERE node_id = ?", (host_id,))
            except Exception:
                pass
            for k, v in headers.items():
                try:
                    db.execute(
                        f"INSERT INTO node_headers (node_id, {key_col}, {val_col}) VALUES (?, ?, ?)",
                        (host_id, k, v),
                    )
                except Exception:
                    pass

        # Update technologies table
        tech_cols = detect_columns(db, "node_technologies")
        tech_col = "technology" if "technology" in tech_cols else ("name" if "name" in tech_cols else None)
        if tech_col:
            try:
                db.execute("DELETE FROM node_technologies WHERE node_id = ?", (host_id,))
            except Exception:
                pass
            for t in sorted(techs):
                try:
                    db.execute(f"INSERT INTO node_technologies (node_id, {tech_col}) VALUES (?, ?)", (host_id, t))
                except Exception:
                    pass

        merge_details(db, host_id, details)

        db.commit()
        print(f"Imported fingerprint for {host} (root={root}) into DB")
    finally:
        db.close()


if __name__ == "__main__":
    main()
