#!/usr/bin/env python3
"""
import_html_links.py <website_url> <json_path>

Reads results/html_links_<domain>.json and inserts discovered endpoints/directories
into the SQLite database (server/data.db), creating nodes and 'contains' relationships
under the correct parent (root domain or subdomain) by hostname.
"""
import sys
import json
import os
import re
from pathlib import Path
import sqlite3
from urllib.parse import urlparse, urlunparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from recon.url_classify import classify_url
from recon.url_canonicalize import canonical_url

SERVER_DIR = PROJECT_ROOT / 'server'
DB_PATH = SERVER_DIR / 'data.db'

_IPV4_RE = re.compile(r"^\\d{1,3}(?:\\.\\d{1,3}){3}$")

def get_host(url_or_host: str) -> str:
    s = (url_or_host or '').strip()
    try:
        p = urlparse(s if '://' in s else f'http://{s}')
        if p.hostname:
            host = p.hostname.lower().rstrip('.')
            port = p.port
            if port in (80, 443):
                port = None
            return f'{host}:{port}' if port else host
    except Exception:
        pass
    # strip scheme and path
    s = re.sub(r'^https?://', '', s, flags=re.I)
    s = s.split('/')[0]
    return s.lower()

def strip_port(host: str) -> str:
    host = (host or '').strip().lower()
    if not host:
        return ''
    if _IPV4_RE.match(host):
        return host
    if ':' in host:
        return host.split(':', 1)[0]
    return host

def is_in_scope(host: str, root: str) -> bool:
    host_base = strip_port(host)
    root_base = strip_port(root)
    if not host_base or not root_base:
        return False
    if _IPV4_RE.match(root_base):
        return host_base == root_base
    if host_base == root_base:
        return True
    return host_base.endswith('.' + root_base)

def normalize_url(u: str) -> str:
    """Normalize a URL for stable node identity (canonical + fragment-free)."""
    try:
        return canonical_url(u, None) or u.strip()
    except Exception:
        return u.strip()

def split_path_segments(path: str):
    """Return list of non-empty segments from a URL path."""
    path = (path or '/')
    path = re.sub(r'/+', '/', path)
    segs = [s for s in path.split('/') if s]
    return segs

def is_file_segment(segment: str) -> bool:
    """Heuristic: if last segment has an extension typical of files/endpoints."""
    if not segment:
        return False
    if '.' not in segment:
        return False
    ext = segment.split('.')[-1].lower()
    return ext in (
        'html','htm','php','asp','aspx','jsp','js','css','png','jpg','jpeg','gif','svg','ico',
        'pdf','xml','json','txt','csv','zip','gz','tar','rar','7z','mp4','woff','woff2','ttf','eot'
    )

def url_ext(u: str) -> str:
    try:
        p = urlparse(u)
        name = (p.path or '').rsplit('/', 1)[-1]
        if '.' in name:
            return name.rsplit('.', 1)[-1].lower()
    except Exception:
        pass
    return ''

def ensure_website(db, website_url: str) -> int:
    cur = db.cursor()
    cur.execute('INSERT OR IGNORE INTO websites (url, name) VALUES (?, ?)', (website_url, website_url))
    cur.execute('SELECT id FROM websites WHERE url = ? LIMIT 1', (website_url,))
    row = cur.fetchone()
    return row[0] if row else None

def get_nodes_map(db, website_id: int):
    cur = db.cursor()
    cur.execute('SELECT id, value, type FROM nodes WHERE website_id = ?', (website_id,))
    id_by_value = {}
    type_by_value = {}
    for nid, value, ntype in cur.fetchall():
        id_by_value[str(value)] = nid
        type_by_value[str(value)] = ntype
    return id_by_value, type_by_value

def ensure_host_node(db, website_id: int, *, root: str, host: str) -> int:
    root = get_host(root)
    host = get_host(host)
    if not is_in_scope(host, root):
        return None
    root_id = insert_node(db, website_id, root, 'domain')
    host_type = 'domain' if host == root else 'subdomain'
    host_id = insert_node(db, website_id, host, host_type)
    if host != root:
        insert_rel(db, root_id, host_id, 'contains')
    return host_id

def insert_node(db, website_id: int, value: str, ntype: str, status=None, size=None) -> int:
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

    try:
        db.execute(
            'INSERT OR IGNORE INTO nodes (website_id, value, type, status, size) VALUES (?, ?, ?, ?, ?)',
            (website_id, value, ntype, status, size),
        )
    except Exception:
        pass
    cur = db.cursor()
    cur.execute('SELECT id, type FROM nodes WHERE website_id = ? AND value = ? LIMIT 1', (website_id, value))
    row = cur.fetchone()
    if row:
        node_id = row[0]
        existing_type = row[1]
        chosen = choose_type(existing_type, ntype)
        try:
            db.execute(
                'UPDATE nodes SET type = ?, status = COALESCE(?, status), size = COALESCE(?, size) WHERE id = ?',
                (chosen, status, size, node_id),
            )
        except Exception:
            pass
        return node_id
    cur.execute('INSERT INTO nodes (website_id, value, type, status, size) VALUES (?, ?, ?, ?, ?)', (website_id, value, ntype, status, size))
    return cur.lastrowid

def merge_details(db, node_id: int, patch: dict):
    cur = db.cursor()
    cur.execute('SELECT details FROM nodes WHERE id = ? LIMIT 1', (node_id,))
    row = cur.fetchone()
    details = {}
    if row and row[0]:
        try:
            details = json.loads(row[0]) if isinstance(row[0], str) else dict(row[0])
        except Exception:
            details = {}
    patch = patch or {}
    # Prefer earliest crawl depth, and highest crawl score if multiple URLs map to the same node value.
    if 'crawl_depth' in patch:
        try:
            incoming = int(patch.get('crawl_depth'))
            existing = int(details.get('crawl_depth')) if 'crawl_depth' in details else None
            if existing is not None:
                patch['crawl_depth'] = min(existing, incoming)
        except Exception:
            pass
    if 'crawl_score' in patch:
        try:
            incoming = float(patch.get('crawl_score'))
            existing = float(details.get('crawl_score')) if 'crawl_score' in details else None
            if existing is not None:
                patch['crawl_score'] = max(existing, incoming)
        except Exception:
            pass
    if 'crawl_parent' in patch and 'crawl_parent' in details:
        # Keep the first seen parent unless the new one is strictly shallower.
        try:
            incoming_depth = int(patch.get('crawl_depth')) if 'crawl_depth' in patch else None
            existing_depth = int(details.get('crawl_depth')) if 'crawl_depth' in details else None
            if existing_depth is not None and incoming_depth is not None and incoming_depth >= existing_depth:
                patch.pop('crawl_parent', None)
        except Exception:
            patch.pop('crawl_parent', None)

    details.update(patch)
    cur.execute('UPDATE nodes SET details = ? WHERE id = ?', (json.dumps(details), node_id))

def insert_rel(db, src_id: int, tgt_id: int, rtype: str = 'contains'):
    cur = db.cursor()
    try:
        cur.execute('INSERT OR IGNORE INTO node_relationships (source_node_id, target_node_id, relationship_type) VALUES (?, ?, ?)', (src_id, tgt_id, rtype))
    except Exception:
        pass

def main():
    if len(sys.argv) < 3:
        print('Usage: python3 import_html_links.py <website_url> <json_path>')
        sys.exit(1)
    website_url = sys.argv[1].strip()
    json_path = Path(sys.argv[2])
    if not json_path.exists():
        print(f'ERROR: JSON file not found: {json_path}')
        sys.exit(2)

    data = json.loads(json_path.read_text())
    discovered = data.get('discovered', {})
    page_urls = discovered.get('pages') or discovered.get('urls') or []
    api_urls = discovered.get('api') or []
    feed_urls = discovered.get('feeds') or []
    asset_urls = discovered.get('assets') or []
    dirs_by_host = discovered.get('directories_by_host', {}) or {}
    crawl_graph = data.get('crawl_graph') or {}
    crawl_nodes = {}
    try:
        for n in (crawl_graph.get('nodes') or []):
            if not isinstance(n, dict):
                continue
            u = n.get('url')
            if not u:
                continue
            cu = canonical_url(str(u), None)
            if not cu:
                continue
            crawl_nodes[cu] = {
                'depth': n.get('depth'),
                'parent': n.get('parent'),
                'score': n.get('score'),
                'kind': n.get('kind')
            }
    except Exception:
        crawl_nodes = {}

    db = sqlite3.connect(str(DB_PATH), timeout=30)
    try:
        db.execute('PRAGMA busy_timeout = 5000')
    except Exception:
        pass
    try:
        website_id = ensure_website(db, website_url)
        root = get_host(website_url)
        root_id = insert_node(db, website_id, root, 'domain')

        # Build hierarchical directory tree and endpoints/files under hosts
        # 1) From directories_by_host (already path-like)
        for host, dir_list in dirs_by_host.items():
            parent_id = ensure_host_node(db, website_id, root=root, host=host)
            if not parent_id:
                continue
            for d in dir_list:
                # Ensure consistent path
                d = re.sub(r'/+', '/', d)
                segs = split_path_segments(d)
                cumulative = ''
                prev_id = parent_id
                for i, seg in enumerate(segs):
                    cumulative = cumulative + '/' + seg if cumulative else '/' + seg
                    node_value = f"{host}{cumulative}"
                    node_id = insert_node(db, website_id, node_value, 'directory')
                    insert_rel(db, prev_id, node_id, 'contains')
                    prev_id = node_id

        # 2) From raw URLs (pages + api). Create directories per segment and final leaf.
        for raw in page_urls:
            if classify_url(raw) != "page":
                continue
            nu = normalize_url(raw)
            p = urlparse(nu)
            host = (p.hostname or '').lower()
            if p.port:
                host = f'{host}:{p.port}'
            if not host:
                continue
            if not is_in_scope(host, root):
                continue
            parent_id = ensure_host_node(db, website_id, root=root, host=host) or root_id

            segs = split_path_segments(p.path or '/')
            if not segs and p.query:
                node_value = f"{host}/?{p.query}"
                node_id = insert_node(db, website_id, node_value, 'endpoint')
                insert_rel(db, parent_id, node_id, 'contains')
                meta = crawl_nodes.get(nu) or {}
                merge_details(db, node_id, {
                    "link_type": "page",
                    "crawl_depth": meta.get("depth"),
                    "crawl_parent": meta.get("parent"),
                    "crawl_score": meta.get("score"),
                    "crawl_kind": meta.get("kind")
                })
                continue
            cumulative = ''
            prev_id = parent_id
            for i, seg in enumerate(segs):
                cumulative = cumulative + '/' + seg if cumulative else '/' + seg
                node_value = f"{host}{cumulative}"
                is_last = (i == len(segs) - 1)
                if is_last and is_file_segment(seg):
                    ntype = 'endpoint'
                else:
                    ntype = 'directory'
                node_id = insert_node(db, website_id, node_value, ntype)
                insert_rel(db, prev_id, node_id, 'contains')
                prev_id = node_id
                if is_last:
                    meta = crawl_nodes.get(nu) or {}
                    merge_details(db, node_id, {
                        "link_type": "page",
                        "crawl_depth": meta.get("depth"),
                        "crawl_parent": meta.get("parent"),
                        "crawl_score": meta.get("score"),
                        "crawl_kind": meta.get("kind")
                    })

        for raw in api_urls:
            if classify_url(raw) != "api":
                continue
            nu = normalize_url(raw)
            p = urlparse(nu)
            host = (p.hostname or '').lower()
            if p.port:
                host = f'{host}:{p.port}'
            if not host:
                continue
            if not is_in_scope(host, root):
                continue
            parent_id = ensure_host_node(db, website_id, root=root, host=host) or root_id

            segs = split_path_segments(p.path or '/')
            if not segs and p.query:
                node_value = f"{host}/?{p.query}"
                node_id = insert_node(db, website_id, node_value, 'endpoint')
                insert_rel(db, parent_id, node_id, 'contains')
                meta = crawl_nodes.get(nu) or {}
                merge_details(db, node_id, {
                    "link_type": "api",
                    "crawl_depth": meta.get("depth"),
                    "crawl_parent": meta.get("parent"),
                    "crawl_score": meta.get("score"),
                    "crawl_kind": meta.get("kind")
                })
                continue
            cumulative = ''
            prev_id = parent_id
            for i, seg in enumerate(segs):
                cumulative = cumulative + '/' + seg if cumulative else '/' + seg
                node_value = f"{host}{cumulative}"
                is_last = (i == len(segs) - 1)
                ntype = 'endpoint' if is_last else 'directory'
                node_id = insert_node(db, website_id, node_value, ntype)
                insert_rel(db, prev_id, node_id, 'contains')
                prev_id = node_id
                if is_last:
                    meta = crawl_nodes.get(nu) or {}
                    merge_details(db, node_id, {
                        "link_type": "api",
                        "crawl_depth": meta.get("depth"),
                        "crawl_parent": meta.get("parent"),
                        "crawl_score": meta.get("score"),
                        "crawl_kind": meta.get("kind")
                    })

        # Assets (default: only high-signal static files like JS/CSS)
        for raw in asset_urls:
            try:
                if url_ext(raw) not in ('js', 'css'):
                    continue
            except Exception:
                continue
            nu = normalize_url(raw)
            p = urlparse(nu)
            host = (p.hostname or '').lower()
            if p.port:
                host = f'{host}:{p.port}'
            if not host:
                continue
            if not is_in_scope(host, root):
                continue
            parent_id = ensure_host_node(db, website_id, root=root, host=host) or root_id

            segs = split_path_segments(p.path or '/')
            if not segs and p.query:
                node_value = f"{host}/?{p.query}"
                node_id = insert_node(db, website_id, node_value, 'file')
                insert_rel(db, parent_id, node_id, 'contains')
                meta = crawl_nodes.get(nu) or {}
                merge_details(db, node_id, {
                    "link_type": "asset",
                    "crawl_depth": meta.get("depth"),
                    "crawl_parent": meta.get("parent"),
                    "crawl_score": meta.get("score"),
                    "crawl_kind": meta.get("kind")
                })
                continue
            cumulative = ''
            prev_id = parent_id
            is_dir_path = (p.path or '').endswith('/')
            for i, seg in enumerate(segs):
                cumulative = cumulative + '/' + seg if cumulative else '/' + seg
                node_value = f"{host}{cumulative}"
                is_last = (i == len(segs) - 1)
                if not is_last or is_dir_path:
                    ntype = 'directory'
                else:
                    ntype = 'file'
                node_id = insert_node(db, website_id, node_value, ntype)
                insert_rel(db, prev_id, node_id, 'contains')
                prev_id = node_id
                if is_last:
                    meta = crawl_nodes.get(nu) or {}
                    merge_details(db, node_id, {
                        "link_type": "asset",
                        "crawl_depth": meta.get("depth"),
                        "crawl_parent": meta.get("parent"),
                        "crawl_score": meta.get("score"),
                        "crawl_kind": meta.get("kind")
                    })

        for raw in feed_urls:
            nu = normalize_url(raw)
            p = urlparse(nu)
            host = (p.hostname or '').lower()
            if p.port:
                host = f'{host}:{p.port}'
            if not host:
                continue
            if not is_in_scope(host, root):
                continue
            parent_id = ensure_host_node(db, website_id, root=root, host=host) or root_id

            segs = split_path_segments(p.path or '/')
            if not segs and p.query:
                node_value = f"{host}/?{p.query}"
                node_id = insert_node(db, website_id, node_value, 'endpoint')
                insert_rel(db, parent_id, node_id, 'contains')
                meta = crawl_nodes.get(nu) or {}
                merge_details(db, node_id, {
                    "link_type": "feed",
                    "crawl_depth": meta.get("depth"),
                    "crawl_parent": meta.get("parent"),
                    "crawl_score": meta.get("score"),
                    "crawl_kind": meta.get("kind")
                })
                continue
            cumulative = ''
            prev_id = parent_id
            for i, seg in enumerate(segs):
                cumulative = cumulative + '/' + seg if cumulative else '/' + seg
                node_value = f"{host}{cumulative}"
                is_last = (i == len(segs) - 1)
                if is_last and is_file_segment(seg):
                    ntype = 'endpoint'
                else:
                    ntype = 'directory'
                node_id = insert_node(db, website_id, node_value, ntype)
                insert_rel(db, prev_id, node_id, 'contains')
                prev_id = node_id
                if is_last:
                    meta = crawl_nodes.get(nu) or {}
                    merge_details(db, node_id, {
                        "link_type": "feed",
                        "crawl_depth": meta.get("depth"),
                        "crawl_parent": meta.get("parent"),
                        "crawl_score": meta.get("score"),
                        "crawl_kind": meta.get("kind")
                    })

        db.commit()
        imported_asset_count = 0
        try:
            imported_asset_count = sum(1 for u in asset_urls if url_ext(u) in ('js', 'css'))
        except Exception:
            imported_asset_count = 0
        print(f'Imported hierarchical paths from {len(page_urls)} pages, {len(api_urls)} api endpoints, {len(feed_urls)} feeds, {imported_asset_count} JS/CSS assets, and {sum(len(v) for v in dirs_by_host.values())} directory hints into DB for {website_url}')
    finally:
        db.close()

if __name__ == '__main__':
    main()
