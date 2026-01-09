#!/usr/bin/env python3
"""
import_nmap_vuln.py <website_url> <nmap_vuln_json>

Reads results/clean/<target>_nmap_vuln.json and merges findings into nodes.details as `vulns.nmap`.
"""
import json
import sqlite3
import sys
from pathlib import Path

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


def parse_host_port(node_value):
    if ":" not in node_value:
        return None, None
    # Example: host:443 or host:443/path
    host_part = node_value.split("/")[0]
    host, port = host_part.rsplit(":", 1)
    if port.isdigit():
        return host, port
    return None, None


def merge_details(existing_details, nmap_findings):
    details = {}
    if existing_details:
        try:
            details = json.loads(existing_details) if isinstance(existing_details, str) else dict(existing_details)
        except Exception:
            details = {}
    vulns = details.get("vulns") or {}
    current = vulns.get("nmap") or []
    combined = current + nmap_findings
    # de-dup by id+port
    seen = set()
    unique = []
    for item in combined:
        key = f"{item.get('id')}|{item.get('port')}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    vulns["nmap"] = unique
    details["vulns"] = vulns
    return json.dumps(details)


def main():
    if len(sys.argv) < 3:
        print("Usage: import_nmap_vuln.py <website_url> <nmap_vuln_json>")
        sys.exit(1)
    website_url = sys.argv[1].strip()
    json_path = Path(sys.argv[2])
    if not json_path.exists():
        print(f"ERROR: JSON file not found: {json_path}")
        sys.exit(2)

    payload = json.loads(json_path.read_text())
    hosts = payload.get("hosts") or {}

    db = sqlite3.connect(str(DB_PATH))
    try:
        ensure_details_column(db)
        website_id = ensure_website(db, website_url)
        nodes = get_nodes(db, website_id)

        host_nodes = {n["value"]: n for n in nodes if "/" not in n["value"]}
        port_nodes = {}
        for n in nodes:
            host, port = parse_host_port(n["value"])
            if host and port:
                port_nodes.setdefault((host, port), []).append(n)

        for host, info in hosts.items():
            hostnames = info.get("hostnames") or []
            host_keys = [host] + [h for h in hostnames if h]
            ports = info.get("ports") or {}
            host_findings = []
            for port_key, pdata in ports.items():
                service = pdata.get("service")
                cves = pdata.get("cves") or []
                port = port_key.split("/")[0] if port_key else ""
                for cve in cves:
                    host_findings.append({
                        "id": cve.get("id"),
                        "cvss": cve.get("cvss"),
                        "source": cve.get("source"),
                        "url": cve.get("url"),
                        "port": port,
                        "service": service
                    })

                for host_key in host_keys:
                    for node in port_nodes.get((host_key, port), []):
                        merged = merge_details(node.get("details"), [{
                            "id": c.get("id"),
                            "cvss": c.get("cvss"),
                            "source": c.get("source"),
                            "url": c.get("url"),
                            "port": port,
                            "service": service
                        } for c in cves])
                        db.execute("UPDATE nodes SET details = ? WHERE id = ?", (merged, node["id"]))
            for host_key in host_keys:
                host_node = host_nodes.get(host_key)
                if host_node and host_findings:
                    merged = merge_details(host_node.get("details"), host_findings)
                    db.execute("UPDATE nodes SET details = ? WHERE id = ?", (merged, host_node["id"]))

        db.commit()
        print(f"Imported nmap vuln findings into nodes.details for {website_url}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
