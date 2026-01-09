#!/usr/bin/env python3
"""
import_dirsearch.py <website_url> <host> <json_path>

Imports dirsearch JSON output into the SQLite database (server/data.db),
creating nodes for each discovered path (endpoint/file/directory) and
linking them under the correct host node via a 'contains' relationship.

The website_url should be the root domain used by the frontend (e.g., scanme.nmap.org),
and host is the specific subdomain or root host that dirsearch scanned (e.g., www.example.com).
"""
import sys
import json
import re
from pathlib import Path
import sqlite3
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = PROJECT_ROOT / 'server'
DB_PATH = SERVER_DIR / 'data.db'

_IPV4_RE = re.compile(r"^\\d{1,3}(?:\\.\\d{1,3}){3}$")


def get_host_from_url_or_host(val: str) -> str:
    s = (val or '').strip()
    if not s:
        return ''
    try:
        p = urlparse(s if '://' in s else f'http://{s}')
        if p.hostname:
            host = p.hostname.lower()
            port = p.port
            if port in (80, 443):
                port = None
            return f'{host}:{port}' if port else host
    except Exception:
        pass
    s = re.sub(r'^https?://', '', s, flags=re.I)
    return (s.split('/')[0]).lower()

def is_in_scope(host: str, root: str) -> bool:
    def strip_port(v: str) -> str:
        v = (v or '').strip().lower()
        if not v:
            return ''
        if _IPV4_RE.match(v):
            return v
        if ':' in v:
            return v.split(':', 1)[0]
        return v

    host_base = strip_port(host)
    root_base = strip_port(root)
    if not host_base or not root_base:
        return False
    if _IPV4_RE.match(root_base):
        return host_base == root_base
    if host_base == root_base:
        return True
    return host_base.endswith('.' + root_base)


def ensure_website(db, website_url: str) -> int:
    cur = db.cursor()
    # Idempotent + concurrency-safe (websites.url is UNIQUE)
    cur.execute('INSERT OR IGNORE INTO websites (url, name) VALUES (?, ?)', (website_url, website_url))
    cur.execute('SELECT id FROM websites WHERE url = ? LIMIT 1', (website_url,))
    row = cur.fetchone()
    return row[0] if row else None


def get_node_by_value(db, website_id: int, value: str):
    cur = db.cursor()
    cur.execute('SELECT id, type FROM nodes WHERE website_id = ? AND value = ? LIMIT 1', (website_id, value))
    row = cur.fetchone()
    if not row:
        return None, None
    return row[0], row[1]


def choose_type(existing_type: str, incoming_type: str) -> str:
    a = (existing_type or '').lower()
    b = (incoming_type or '').lower()
    if not a:
        return incoming_type
    if not b:
        return existing_type

    ranks = {
        'domain': 50,
        'subdomain': 45,
        'ip': 40,
        'endpoint': 30,
        'path': 30,
        'file': 30,
        'directory': 20,
        'dir': 20,
        'unknown': 0,
    }
    ra = ranks.get(a, 10)
    rb = ranks.get(b, 10)
    return incoming_type if rb > ra else existing_type


def insert_node(db, website_id: int, value: str, ntype: str, status=None, size=None) -> int:
    # Concurrency-safe when nodes(website_id,value) is UNIQUE (server migration ensures this).
    # Also safe to call repeatedly (idempotent).
    try:
        db.execute(
            'INSERT OR IGNORE INTO nodes (website_id, value, type, status, size) VALUES (?, ?, ?, ?, ?)',
            (website_id, value, ntype, status, size),
        )
    except Exception:
        pass

    node_id, existing_type = get_node_by_value(db, website_id, value)
    if not node_id:
        cur = db.cursor()
        cur.execute('INSERT INTO nodes (website_id, value, type, status, size) VALUES (?, ?, ?, ?, ?)', (website_id, value, ntype, status, size))
        return cur.lastrowid

    chosen_type = choose_type(existing_type, ntype)
    try:
        db.execute(
            'UPDATE nodes SET type = ?, status = COALESCE(?, status), size = COALESCE(?, size) WHERE id = ?',
            (chosen_type, status, size, node_id),
        )
    except Exception:
        pass
    return node_id


def insert_rel(db, src_id: int, tgt_id: int, rtype: str = 'contains'):
    try:
        db.execute('INSERT OR IGNORE INTO node_relationships (source_node_id, target_node_id, relationship_type) VALUES (?, ?, ?)', (src_id, tgt_id, rtype))
    except Exception:
        pass


def classify_type_from_segment(segment: str, is_last: bool) -> str:
    if not is_last:
        return 'directory'
    if '.' in (segment or ''):
        ext = segment.split('.')[-1].lower()
        if ext in ('png','jpg','jpeg','gif','svg','js','css','zip','pdf','mp4','xml','json','txt','bak','conf','sql','ini','yaml','yml','php','asp','aspx','ico','woff','woff2','ttf','eot'):
            return 'endpoint'
    return 'endpoint'

def split_path_segments(path: str):
    path = (path or '/')
    path = re.sub(r'/+', '/', path)
    return [s for s in path.split('/') if s]


def normalize_host(host: str) -> str:
    host = (host or '').strip()
    if not host:
        return ''
    return get_host_from_url_or_host(host)


def detect_schemes(results):
    schemes = set()
    for item in results:
        if not isinstance(item, dict):
            continue
        url_val = item.get('url') or ''
        if '://' not in url_val:
            continue
        try:
            p = urlparse(url_val)
            if p.scheme:
                schemes.add(p.scheme.lower())
        except Exception:
            continue
    return sorted(schemes)


def choose_scheme(schemes):
    if 'https' in schemes and 'http' in schemes:
        print('Using https (preferred)')
        return 'https'
    if schemes:
        chosen = schemes[0]
        print(f'Using {chosen} (only available)')
        return chosen
    print('WARNING: No schemes detected; defaulting to https')
    return 'https'


def parse_dirsearch_item(item, default_scheme, default_host, index):
    if not isinstance(item, dict):
        print(f'WARN: Skipping record #{index} (expected dict)')
        return None
    url_or_path = item.get('url') or item.get('path') or item.get('target') or ''
    if not url_or_path:
        print(f'WARN: Skipping record #{index} (missing url/path)')
        return None
    raw = str(url_or_path).strip()
    raw = raw.split('#')[0]
    has_scheme = '://' in raw
    try:
        if has_scheme:
            p = urlparse(raw)
        elif raw.startswith('/'):
            p = urlparse(f'{default_scheme}://{default_host}{raw}')
        else:
            p = urlparse(f'{default_scheme}://{default_host}/' + raw)
    except Exception:
        print(f'WARN: Skipping record #{index} (unparseable url/path)')
        return None
    host = p.hostname.lower() if p.hostname else default_host
    port = p.port
    if port in (80, 443):
        port = None
    if port:
        host = f'{host}:{port}'
    path = p.path or '/'
    path = re.sub(r'/+', '/', path)
    if not path.startswith('/'):
        path = '/' + path
    return {
        'host': host,
        'path': path,
        'status': item.get('status') or item.get('code'),
        'size': item.get('contentLength') or item.get('length') or item.get('size')
    }


def main():
    if len(sys.argv) < 4:
        print('Usage: python3 import_dirsearch.py <website_url> <host> <json_path>')
        sys.exit(1)

    if len(sys.argv) >= 2 and sys.argv[1] == '--self-check':
        sample_results = [
            {'url': 'http://www.example.com/admin/'},
            {'url': 'https://www.example.com/assets/app.js?ver=1.2.3'},
            {'path': '/images/logo.png'},
            {},
            'bad-entry'
        ]
        schemes = detect_schemes(sample_results)
        print(f'Detected schemes: {schemes}')
        scheme = choose_scheme(schemes)
        host = normalize_host('www.example.com')
        for idx, item in enumerate(sample_results):
            parsed = parse_dirsearch_item(item, scheme, host, idx)
            if parsed:
                print(f'Parsed #{idx}: host={parsed["host"]} path={parsed["path"]}')
        schemes = detect_schemes([{'url': 'http://only-http.local/path'}])
        print(f'Detected schemes: {schemes}')
        choose_scheme(schemes)
        schemes = detect_schemes([])
        print(f'Detected schemes: {schemes}')
        choose_scheme(schemes)
        return

    website_url = sys.argv[1].strip()
    host = normalize_host(sys.argv[2])
    json_path = Path(sys.argv[3])

    if not json_path.exists():
        print(f'ERROR: JSON file not found: {json_path}')
        sys.exit(2)

    # Load dirsearch JSON. It can either be a dict with key "results" or a raw list
    raw = json.loads(json_path.read_text(encoding='utf-8', errors='replace'))
    results = raw.get('results') if isinstance(raw, dict) else raw
    if not isinstance(results, list):
        print('ERROR: Unexpected dirsearch JSON format (no list results)')
        sys.exit(3)

    db = sqlite3.connect(str(DB_PATH), timeout=30)
    try:
        db.execute('PRAGMA busy_timeout = 5000')
    except Exception:
        pass
    inserted = 0
    try:
        website_id = ensure_website(db, website_url)

        root = get_host_from_url_or_host(website_url)
        if not root:
            root = host
        if not is_in_scope(host, root):
            print(f'ERROR: host {host} is out of scope for website {root}')
            sys.exit(4)
        root_id = insert_node(db, website_id, root, 'domain')

        # Ensure parent host node exists and link it under the root website node.
        parent_id = insert_node(db, website_id, host, 'domain' if host == root else 'subdomain')
        if host != root:
            insert_rel(db, root_id, parent_id, 'contains')

        schemes = detect_schemes(results)
        print(f'Detected schemes for {host}: {schemes}')
        chosen_scheme = choose_scheme(schemes)

        for idx, item in enumerate(results):
            parsed = parse_dirsearch_item(item, chosen_scheme, host, idx)
            if not parsed:
                continue
            path = parsed['path']
            segs = split_path_segments(path)
            cumulative = ''
            prev_id = parent_id
            for i, seg in enumerate(segs):
                cumulative = cumulative + '/' + seg if cumulative else '/' + seg
                node_value = f"{parsed['host']}{cumulative}"
                ntype = classify_type_from_segment(seg, is_last=(i == len(segs) - 1))
                node_id = insert_node(db, website_id, node_value, ntype,
                                      status=parsed['status'],
                                      size=parsed['size'])
                insert_rel(db, prev_id, node_id, 'contains')
                prev_id = node_id
            inserted += 1

        # Update a convenience counter on the parent host node if column exists.
        # Idempotent: set to the current import's count (do not increment).
        try:
            db.execute('UPDATE nodes SET dirsearch_count = ? WHERE id = ?', (inserted, parent_id))
        except Exception:
            pass

        db.commit()
        print(f'Imported {inserted} dirsearch items for host {host} under website {website_url}')
    finally:
        db.close()


if __name__ == '__main__':
    main()
