#!/usr/bin/env python3
"""
import_nuclei.py <website_url> <nuclei_json>

Reads results/clean/<target>_nuclei.json and merges findings into nodes.details as `vulns.nuclei`.
"""
import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "server" / "data.db"


def ensure_details_column(db):
    cur = db.cursor()
    cur.execute("PRAGMA table_info('nodes')")
    cols = [c[1] for c in cur.fetchall()]
    if "details" not in cols:
        cur.execute("ALTER TABLE nodes ADD COLUMN details TEXT")


def ensure_website(db, website_url: str) -> int:
    cur = db.cursor()
    cur.execute("INSERT OR IGNORE INTO websites (url, name) VALUES (?, ?)", (website_url, website_url))
    cur.execute("SELECT id FROM websites WHERE url = ? LIMIT 1", (website_url,))
    row = cur.fetchone()
    return row[0] if row else None


def get_nodes(db, website_id: int):
    cur = db.cursor()
    cur.execute("SELECT id, value, type, details FROM nodes WHERE website_id = ?", (website_id,))
    rows = cur.fetchall()
    nodes = []
    for nid, value, ntype, details in rows:
        nodes.append({"id": nid, "value": str(value), "type": ntype, "details": details})
    return nodes


def normalize_matched(url: str):
    try:
        parsed = urlparse(url)
        if not parsed.hostname:
            return ""
        host = parsed.hostname.lower()
        path = parsed.path or "/"
        path = re.sub(r"/{2,}", "/", path)
        if len(path) > 1 and path.endswith("/"):
            path = path[:-1]
        return f"{host}{path}"
    except Exception:
        return ""


def merge_details(existing_details, nuclei_findings):
    details = {}
    if existing_details:
        try:
            details = json.loads(existing_details) if isinstance(existing_details, str) else dict(existing_details)
        except Exception:
            details = {}
    vulns = details.get("vulns") or {}
    current = vulns.get("nuclei") or []
    combined = current + nuclei_findings
    seen = set()
    unique = []
    for item in combined:
        key = f"{item.get('template')}|{item.get('url')}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    vulns["nuclei"] = unique
    details["vulns"] = vulns
    return json.dumps(details)


def main():
    if len(sys.argv) < 3:
        print("Usage: import_nuclei.py <website_url> <nuclei_json>")
        sys.exit(1)
    website_url = sys.argv[1].strip()
    json_path = Path(sys.argv[2])
    if not json_path.exists():
        print(f"ERROR: JSON file not found: {json_path}")
        sys.exit(2)

    payload = json.loads(json_path.read_text())
    findings = payload.get("findings") or []

    db = sqlite3.connect(str(DB_PATH))
    try:
        ensure_details_column(db)
        website_id = ensure_website(db, website_url)
        nodes = get_nodes(db, website_id)
        host_nodes = {n["value"]: n for n in nodes if "/" not in n["value"]}
        path_nodes = [n for n in nodes if "/" in n["value"]]
        path_nodes.sort(key=lambda n: len(n["value"]), reverse=True)

        host_findings = {}
        path_findings = {}

        for finding in findings:
            matched = finding.get("url") or finding.get("matchedAt") or ""
            normalized = normalize_matched(matched)
            if not normalized:
                continue
            host = normalized.split("/")[0]
            host_findings.setdefault(host, []).append(finding)
            for node in path_nodes:
                if normalized.startswith(node["value"]):
                    path_findings.setdefault(node["value"], []).append(finding)

        for host, items in host_findings.items():
            node = host_nodes.get(host)
            if not node:
                continue
            merged = merge_details(node.get("details"), items)
            db.execute("UPDATE nodes SET details = ? WHERE id = ?", (merged, node["id"]))

        for path_value, items in path_findings.items():
            node = next((n for n in path_nodes if n["value"] == path_value), None)
            if not node:
                continue
            merged = merge_details(node.get("details"), items)
            db.execute("UPDATE nodes SET details = ? WHERE id = ?", (merged, node["id"]))

        db.commit()
        print(f"Imported nuclei findings into nodes.details for {website_url}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
