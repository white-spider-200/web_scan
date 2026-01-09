#!/usr/bin/env python3
"""
build_hierarchical_json.py <input_html_links_json> <output_json>

Reads an HTML links discovery JSON (like results/html_links_<domain>.json) and
produces a hierarchical JSON with domain/subdomain, directory nodes per segment,
final endpoints for file-like leaves, plus parent-child "contains" relationships.

This does NOT touch the database; it only generates a JSON artifact suitable for
visualization or further import.
"""
import sys
import json
import re
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from recon.url_classify import classify_url, should_graph
from recon.url_canonicalize import canonical_url
from datetime import datetime

FILE_EXTS = {
    'html','htm','php','asp','aspx','jsp','js','css','png','jpg','jpeg','gif','svg','ico',
    'pdf','xml','json','txt','csv','zip','gz','tar','rar','7z','mp4','woff','woff2','ttf','eot'
}

def apex_of(host: str) -> str:
    host = (host or '').lower()
    parts = host.split('.')
    return '.'.join(parts[-2:]) if len(parts) >= 2 else host


def get_host(url_or_host: str) -> str:
    s = (url_or_host or '').strip()
    try:
        p = urlparse(s)
        if p.scheme and p.hostname:
            return p.hostname.lower()
    except Exception:
        pass
    s = re.sub(r'^https?://', '', s, flags=re.I)
    return (s.split('/')[0]).lower()


def split_segments(path: str):
    path = re.sub(r'/+', '/', path or '/')
    return [seg for seg in path.split('/') if seg]


def is_file_segment(seg: str) -> bool:
    if not seg or '.' not in seg:
        return False
    ext = seg.split('.')[-1].lower()
    return ext in FILE_EXTS


def add_node(nodes, value, ntype):
    if value in nodes:
        # keep earliest type; or prefer directory over endpoint for stability
        return
    nodes[value] = {'id': value, 'value': value, 'type': ntype}


def add_edge(edges, src, tgt):
    key = (src, tgt, 'contains')
    if key in edges:
        return
    edges[key] = {'source': src, 'target': tgt, 'type': 'contains'}


def build_hierarchy(discovered):
    page_urls = discovered.get('pages') or discovered.get('urls', []) or []
    api_urls = discovered.get('api') or []
    raw_urls = list(page_urls) + list(api_urls)
    urls = []
    for u in raw_urls:
        cu = canonical_url(u, None) or u
        if cu and should_graph(classify_url(cu)):
            urls.append(cu)
    nodes = {}
    edges = {}

    # Also include subdomains if provided
    for h in (discovered.get('subdomains') or []):
        add_node(nodes, h, 'subdomain' if h != apex_of(h) else 'domain')

    for raw in urls:
        try:
            p = urlparse(raw)
            host = (p.hostname or '').lower()
            if not host:
                host = get_host(raw)
            if not host:
                continue
            # ensure root host node exists
            add_node(nodes, host, 'subdomain' if host != apex_of(host) else 'domain')

            segs = split_segments(p.path or '/')
            if not segs and p.query:
                node_value = f"{host}/?{p.query}"
                add_node(nodes, node_value, 'endpoint')
                add_edge(edges, host, node_value)
                continue
            prev = host
            cumulative = ''
            for i, seg in enumerate(segs):
                cumulative = cumulative + '/' + seg if cumulative else '/' + seg
                node_value = f"{host}{cumulative}"
                ntype = 'endpoint' if (i == len(segs) - 1 and is_file_segment(seg)) else 'directory'
                add_node(nodes, node_value, ntype)
                add_edge(edges, prev, node_value)
                prev = node_value
        except Exception:
            continue

    return {
        'nodes': list(nodes.values()),
        'relationships': list(edges.values())
    }

def _utc_now_iso():
    return datetime.utcnow().isoformat(timespec='seconds') + 'Z'

def normalize_matched_url(raw: str) -> str:
    try:
        parsed = urlparse(raw)
        if not parsed.hostname:
            return ''
        host = parsed.hostname.lower()
        path = parsed.path or '/'
        path = re.sub(r'/+', '/', path)
        if len(path) > 1 and path.endswith('/'):
            path = path[:-1]
        return f"{host}{path}"
    except Exception:
        return ''

def load_nmap_vuln(clean_dir: Path, target: str):
    path = clean_dir / f"{target}_nmap_vuln.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    hosts = data.get('hosts') or {}
    host_findings = {}
    for host, info in hosts.items():
        ports = info.get('ports') or {}
        hostnames = info.get('hostnames') or []
        findings = []
        for port_key, pdata in ports.items():
            service = pdata.get('service')
            port = port_key.split('/')[0] if port_key else ''
            for cve in (pdata.get('cves') or []):
                findings.append({
                    'id': cve.get('id'),
                    'cvss': cve.get('cvss'),
                    'source': cve.get('source'),
                    'url': cve.get('url'),
                    'port': port,
                    'service': service
                })
        if findings:
            host_findings[host] = findings
            for hostname in hostnames:
                if hostname:
                    host_findings[hostname] = findings
    return host_findings

def load_nuclei_vuln(clean_dir: Path, target: str):
    path = clean_dir / f"{target}_nuclei.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    return data.get('findings') or []

def attach_vulns(nodes, target: str, clean_dir: Path):
    nmap_by_host = load_nmap_vuln(clean_dir, target)
    nuclei_findings = load_nuclei_vuln(clean_dir, target)
    if not nmap_by_host and not nuclei_findings:
        return nodes

    host_nodes = [n for n in nodes if '/' not in n['value']]
    path_nodes = [n for n in nodes if '/' in n['value']]
    path_nodes.sort(key=lambda n: len(n['value']), reverse=True)

    nuclei_by_host = {}
    nuclei_by_path = {}
    for finding in nuclei_findings:
        matched = finding.get('url') or finding.get('matchedAt') or ''
        normalized = normalize_matched_url(matched)
        if not normalized:
            continue
        host = normalized.split('/')[0]
        nuclei_by_host.setdefault(host, []).append(finding)
        for node in path_nodes:
            if normalized.startswith(node['value']):
                nuclei_by_path.setdefault(node['value'], []).append(finding)

    for node in nodes:
        value = node.get('value') or node.get('id')
        if not value:
            continue
        if '/' not in value:
            node['vulns'] = {
                'nmap': nmap_by_host.get(value, []),
                'nuclei': nuclei_by_host.get(value, [])
            }
        else:
            node['vulns'] = {
                'nmap': [],
                'nuclei': nuclei_by_path.get(value, [])
            }
    return nodes


def main():
    if len(sys.argv) < 3:
        print('Usage: build_hierarchical_json.py <input_html_links_json> <output_json>')
        sys.exit(1)
    inp = Path(sys.argv[1])
    outp = Path(sys.argv[2])
    if not inp.exists():
        print(f'Input JSON not found: {inp}')
        sys.exit(2)
    try:
        data = json.loads(inp.read_text())
        discovered = data.get('discovered') or {}
        target = data.get('target') or ''
        hierarchy = build_hierarchy(discovered)
        clean_dir = inp.parent / 'clean'
        if target:
            hierarchy['nodes'] = attach_vulns(hierarchy['nodes'], target, clean_dir)
        out = {
            'website': {'url': target, 'name': target},
            'generatedAt': _utc_now_iso(),
            **hierarchy
        }
        outp.parent.mkdir(parents=True, exist_ok=True)
        outp.write_text(json.dumps(out, indent=2))
        print(f'Wrote hierarchical JSON: {outp}')
    except Exception as e:
        print(f'ERROR: {e}')
        sys.exit(3)

if __name__ == '__main__':
    main()
